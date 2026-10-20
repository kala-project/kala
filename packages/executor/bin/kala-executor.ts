#!/usr/bin/env node
/**
 * `kala-executor` CLI.
 *
 * Env / flags:
 *   HOST_URL / --host           required (e.g. http://localhost:3000)
 *   WORKSPACE_NAME / --name     optional display label; defaults to os.hostname().
 *                               Free to rename — routing uses the workspaceId
 *                               (persisted at ~/.kala/workspace-id).
 *   SANDBOX_ROOTS / --sandbox-root
 *     optional workspace root(s). Absolute path(s). `SANDBOX_ROOTS` is a
 *     `:`-separated list; `--sandbox-root <path>` is repeatable. Session cwd
 *     may be the root itself or any child directory. Empty = no jail
 *     (executor trusts the whole machine).
 *   EXECUTOR_TOKEN / --token    optional long-term executor token
 *   EXECUTOR_INVITE / --invite  optional invite token from Dashboard
 *   EXECUTOR_ID / --id          optional; defaults to a ULID
 *   KALA_EXECUTOR_PROFILE / --profile
 *     optional local profile. Non-default profiles use isolated lock,
 *     workspace-id, and executor-token files under ~/.kala/profiles/<profile>/.
 *   KALA_AUTO_UPDATE / --auto-update
 *     optional; update the release asset from the latest GitHub Release before connecting.
 *   KALA_NO_UPDATE_CHECK / --no-update-check
 *     optional; disable the default latest-release reminder.
 *
 * The executor is a daemon: it does NOT bind to a sessionId at startup.
 * The host routes `tool:call` messages to it for any session whose
 * `workspaceId` matches this executor's stored workspace id.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve, join, sep } from 'node:path'
import process from 'node:process'

import lockfile from 'proper-lockfile'

import { PROTOCOL_VERSION } from '@agent-kernel/shared'
import { startExecutor } from '../src/client.js'
import { discoverExecutorReplicas, startExecutorReplicaFleet } from '../src/replica-fleet.js'
import { createRuntimeLogger } from '../src/logger.js'
import { checkExecutorUpdate } from '../src/update.js'
import { applyManagedUpdate, rollbackManagedUpdate } from '../src/update-runtime.js'
import { installManagedGeneration, managedInstallSourceExecutable } from '../src/managed-install.js'
import { startUpdateControlServer } from '../src/update-control.js'
import { executorReleaseVersion } from '../src/build-info.js'
import { hashExecutorInviteRoute, loadExecutorRouteHint, loadExecutorToken, saveExecutorRouteHint, saveExecutorToken } from '../src/executor-token.js'
import { readPairingJson } from '../src/pairing-response.js'
import { readExecutorCredential, readExecutorRuntimeConfig } from '../src/executor-config.js'
import { parseSandboxRootsEnv } from '../src/sandbox-roots-env.js'
import { executorProfileDir, loadOrCreateWorkspaceId, normalizeExecutorProfile } from '../src/workspace-id.js'
import { acquireExecutorLock } from '../src/local-lock.js'
import { assertSupportedInstallerPrivileges, bootstrapEnvironment, defaultManagedRoot, downloadExecutorUpdateAssets, redeemInstallation, reportInstallation, waitForApproval, writeInstallerSession } from '../src/installer-flow.js'
import { createLinuxServicePlan, executeLinuxServicePlan, linuxServicePaths, type Command } from '../src/linux-service.js'
import { assertElevatedWindowsAdministrator, assertManagedWindowsInstallation, copyWindowsNodePtyRuntime, copyWindowsServiceHost, createWindowsSelfRemovalPlan, createWindowsServicePlan, deleteWindowsSelfRemovalTask, encodeWindowsTaskXml, executeWindowsServicePlan, registerWindowsSelfRemovalTask, renderWindowsServiceConfig, secureWindowsServiceDataDir, waitForWindowsServiceStopped, type WindowsServiceAction } from '../src/windows-service.js'
import type { ServiceAction, ServiceMode } from '../src/cli-args.js'
import type { InstallerSession } from '../src/installer-session.js'
import { spawn } from 'node:child_process'
import { homedir, hostname, tmpdir } from 'node:os'
import { ulid } from 'ulid'
import { parseMcpServerDeclaration, parseMcpServers, type McpServerConfig } from '../src/mcp-config.js'

const logger = createRuntimeLogger('kala-executor')

type Args = {
  help?: boolean
  version?: boolean
  host?: string
  name?: string
  sandboxRoots: string[]
  token?: string
  invite?: string
  id?: string
  profile?: string
  autoUpdate?: boolean
  noUpdateCheck?: boolean
  updateRepo?: string
  config?: string
  command?: 'run' | 'update' | 'service'
  updateAction?: 'apply' | 'rollback'
  serviceAction?: Exclude<ServiceAction, 'install'>
  serviceMode?: ServiceMode
  mcpServers: McpServerConfig[]
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = { sandboxRoots: [], mcpServers: [], command: argv[0] === 'update' ? 'update' : argv[0] === 'service' ? 'service' : 'run' }
  let start = 0
  if (out.command === 'update') {
    if (argv[1] !== 'apply' && argv[1] !== 'rollback') throw new Error('Usage: kala-executor update apply|rollback --config <path>')
    out.updateAction = argv[1]
    start = 2
  } else if (out.command === 'service') {
    const action = argv[1]
    if (!['status', 'logs', 'start', 'stop', 'restart', 'uninstall'].includes(action ?? '')) throw new Error('Usage: kala-executor service status|logs|start|stop|restart|uninstall [--system|--user]')
    out.serviceAction = action as Args['serviceAction']
    start = 2
  }
  for (let i = start; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') continue
    const eq = a.indexOf('=')
    const [key, inline] =
      eq === -1 ? [a, undefined] : [a.slice(0, eq), a.slice(eq + 1)]
    switch (key) {
      case '--auto-update':
        out.autoUpdate = true
        break
      case '--system':
        out.serviceMode = 'system'
        break
      case '--user':
        out.serviceMode = 'user'
        break
      case '-h':
      case '--help':
        out.help = true
        break
      case '-v':
      case '--version':
        out.version = true
        break
      case '--no-update-check':
        out.noUpdateCheck = true
        break
      case '--host':
      case '--name':
      case '--sandbox-root':
      case '--token':
      case '--invite':
      case '--id':
      case '--profile':
      case '--update-repo':
      case '--config': {
        const value = inline ?? argv[++i]
        if (value === undefined) break
        if (key === '--host') out.host = value
        else if (key === '--name') out.name = value
        else if (key === '--sandbox-root') out.sandboxRoots.push(value)
        else if (key === '--token') out.token = value
        else if (key === '--invite') out.invite = value
        else if (key === '--id') out.id = value
        else if (key === '--profile') out.profile = value
        else if (key === '--config') out.config = value
        else out.updateRepo = value
        break
      }
      case '--mcp': {
        const value = inline ?? argv[++i]
        if (value === undefined) throw new Error('Missing value for --mcp')
        out.mcpServers.push(parseMcpServerDeclaration(value))
        break
      }
      default:
        break
    }
  }
  return out
}

function printHelp(): void {
  process.stdout.write(`Kala Executor

Usage:
  kala-executor --host <url> [options]
  kala-executor service status|logs|start|stop|restart|uninstall [--system|--user]
  kala-executor update apply|rollback --config <path>

Options:
  -h, --help                 Show this help and exit.
  -v, --version              Print version and exit.
  --host <url>               Host URL to connect to. Defaults to HOST_URL.
  --name <workspace>         Workspace display name. Defaults to WORKSPACE_NAME or hostname.
  --sandbox-root <path>      Allowed filesystem root. Repeatable. Defaults to SANDBOX_ROOTS.
  --token <token>            Long-term executor token. Defaults to EXECUTOR_TOKEN.
  --invite <token>           One-time invite token. Defaults to EXECUTOR_INVITE.
  --id <id>                  Executor id. Defaults to EXECUTOR_ID or generated id.
  --profile <name>           Local profile for lock, workspace id, and token files.
  --auto-update              Update release asset before connecting.
  --no-update-check          Disable release update check.
  --update-repo <owner/repo> GitHub release repo. Defaults to KALA_UPDATE_REPO.
  --config <path>             Managed service JSON config; credentials are loaded from its protected file.
  --mcp <json>                Structured MCP server {name,command,args,env}; repeatable.
  --system                    Manage the system service.
  --user                      Manage the current user's service.

Common environment:
  HOST_URL                   Host URL used when --host is omitted.
  WORKSPACE_NAME             Workspace display name.
  SANDBOX_ROOTS              Colon-separated sandbox roots.
  EXECUTOR_TOKEN             Long-term executor token.
  EXECUTOR_INVITE            One-time invite token.
  MCP_SERVERS                JSON array of structured MCP server declarations.
  KALA_EXECUTOR_PROFILE
                             Local profile. Example: dev.
  LOG_LEVEL                  trace, debug, info, warn, error. Default: info.
  LOG_FORMAT                 pretty/human or json. Default: pretty.

Examples:
  kala-executor --host http://localhost:3000 --sandbox-root /workspace
  kala-executor --host http://localhost:3000 --profile dev
  kala-executor service status
  kala-executor service logs
  kala-executor service restart
  kala-executor service stop
  kala-executor service uninstall
`)
}

function printVersion(): void {
  process.stdout.write(`Kala Executor ${executorReleaseVersion()}\n`)
}

function printServiceCommands(mode: ServiceMode, executable = process.execPath): void {
  const user = mode === 'user' ? ' --user' : ''
  const modeFlag = mode === 'user' ? '--user' : '--system'
  process.stdout.write(`\n============================================================\n`)
  process.stdout.write(`  SERVICE INSTALLED AND RUNNING\n`)
  process.stdout.write(`============================================================\n`)
  process.stdout.write(`\nManage the Kala Executor service:\n\n`)
  process.stdout.write(`  Status    systemctl${user} status kala-executor.service\n`)
  process.stdout.write(`  Logs      journalctl${user} -u kala-executor.service -f\n`)
  process.stdout.write(`  Restart   systemctl${user} restart kala-executor.service\n`)
  process.stdout.write(`  Stop      systemctl${user} stop kala-executor.service\n`)
  process.stdout.write(`  Start     systemctl${user} start kala-executor.service\n`)
  process.stdout.write(`  Uninstall ${JSON.stringify(executable)} service uninstall ${modeFlag}\n`)
  process.stdout.write(`\nThese commands are also available through the installed Executor CLI.\n`)
}

function printForegroundCommands(): void {
  process.stdout.write(`\n============================================================\n`)
  process.stdout.write(`  EXECUTOR CONNECTED - FOREGROUND MODE\n`)
  process.stdout.write(`============================================================\n`)
  process.stdout.write(`\n  Stop    Press Ctrl+C\n`)
  process.stdout.write(`  Status  Look for \"welcome from host\" and \"awaiting tool calls\" above\n`)
  process.stdout.write(`  Logs    This terminal is the live log stream (LOG_LEVEL=debug for details)\n`)
  process.stdout.write(`\nKeep this terminal open while using this Workspace.\n`)
}

/**
 * Acquire a single-instance lock at `~/.kala/executor.lock`. Fails
 * fast (no retry) if another executor process on the same user account is
 * already running. The lock is released automatically on process exit;
 * `proper-lockfile` also uses mtime-based stale detection so a crashed
 * executor's lock becomes reclaimable after 30 seconds.
 */
async function acquireLocalLock(
  logger: ReturnType<typeof createRuntimeLogger>,
  profile?: string,
): Promise<string> {
  try {
    return await acquireExecutorLock(executorProfileDir(profile), logger)
  } catch {
    process.exit(1)
  }
}

async function runInternalInstaller(): Promise<void> {
  const env = bootstrapEnvironment(process.env)
  assertSupportedInstallerPrivileges(env, process.getuid?.() === 0)
  await reportInstallation(env, 'asset_verified')
  await reportInstallation(env, 'pairing_pending')
  await waitForApproval(env)
  const workspaceId = loadOrCreateWorkspaceId()
  const redeemed = await redeemInstallation(env, workspaceId)
  // The bootstrap is no longer needed. Workspace tools and service installer
  // subprocesses must not inherit installation credentials from this process.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('EXECUTOR_INSTALL_') || key === 'EXECUTOR_TOKEN') delete process.env[key]
  }
  const workspaceRoot = env.EXECUTOR_INSTALL_ROOT === '__KALA_CURRENT_DIRECTORY__' ? resolve(process.cwd()) : resolve(env.EXECUTOR_INSTALL_ROOT)
  process.stdout.write(`Kala workspace root: ${workspaceRoot}\n`)
  const service = env.EXECUTOR_INSTALL_MODE === 'service'
  if (service && process.platform === 'win32') return await installWindowsService(env, workspaceRoot, redeemed.token, workspaceId)
  const managedRoot = defaultManagedRoot(homedir(), service && process.getuid?.() === 0)
  const release = executorReleaseVersion()
  let managedInstall
  if (service) {
    const installSource = managedInstallSourceExecutable(process.execPath, process.argv[1])
    managedInstall = installManagedGeneration(installSource, managedRoot, release, installSource === process.execPath ? undefined : process.execPath)
  }
  const executable = managedInstall?.executable ?? process.execPath
  const updateAssets = service ? await downloadExecutorUpdateAssets(env.HOST_URL) : undefined
  if (service && !updateAssets) {
    process.stdout.write('Kala automatic updates are unavailable for this deployment; continuing without managed updates.\n')
  }
  const installerSession: InstallerSession = {
    version: 1, mode: service && process.getuid?.() === 0 ? 'system' : 'user', executable,
    privilegeMode: env.EXECUTOR_PRIVILEGE_MODE,
    host: env.HOST_URL, ...(env.EXECUTOR_INSTALL_LABEL ? { name: env.EXECUTOR_INSTALL_LABEL } : {}),
    sandboxRoots: [workspaceRoot], credential: { token: redeemed.token }, installationId: env.EXECUTOR_INSTALL_ID,
    ...(service ? {
      managedRoot,
      ...(updateAssets ? { update: {
        manifestUrl: updateAssets.manifestUrl,
        publicKeyFile: join(managedRoot, 'update-public-key.pem'),
        channel: 'stable' as const,
        intervalMinutes: 60,
      } } : {}),
    } : {}),
  }
  if (!service) {
    await reportInstallation(env, 'starting')
    return await main(['--host', env.HOST_URL, '--sandbox-root', workspaceRoot, '--config', writeTemporaryConfig(installerSession)])
  }
  if (updateAssets) writeFileSync(join(managedRoot, 'update-public-key.pem'), updateAssets.publicKey, { mode: 0o600 })
  const sessionFile = join(managedRoot, 'installer-session.json')
  writeInstallerSession(sessionFile, installerSession)
  const plan = createLinuxServicePlan('install', installerSession.mode, homedir(), installerSession)
  await reportInstallation(env, 'service_installing')
  // Enter `starting` before `systemctl enable --now`: a fast service can announce
  // during that command, and Host only accepts online completion from starting.
  await reportInstallation(env, 'starting')
  await executeLinuxServicePlan(plan, { run: runServiceCommand })
  rmSync(sessionFile, { force: true })
  process.stdout.write(`[4/4] Service started and connected.\n`)
  printServiceCommands(installerSession.mode, executable)
}

async function runInviteInstaller(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Invite installation is available on Windows only')
  const host = process.env.HOST_URL?.replace(/\/$/u, '')
  const invite = process.env.EXECUTOR_INVITE
  const mode = process.env.KALA_INVITE_INSTALL_MODE
  if (!host || !invite || !/^ak_invite_[A-Za-z0-9_-]+$/u.test(invite) || (mode !== 'temporary' && mode !== 'service')) throw new Error('Invalid invite installation environment')
  const hostUrl = new URL(host)
  if (hostUrl.username || hostUrl.password || hostUrl.search || hostUrl.hash || (hostUrl.protocol !== 'https:' && !(hostUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostUrl.hostname)))) throw new Error('Invite installation requires a secure Host URL')
  const workspaceRoot = resolve(process.cwd())
  if (mode === 'temporary') {
    await main(['--host', host, '--sandbox-root', workspaceRoot])
    return
  }
  if (basename(process.execPath).toLowerCase() === 'node.exe') throw new Error('Windows service mode requires the native kala-executor asset')
  await assertElevatedWindowsAdministrator()
  process.stdout.write('Starting Private Cloud invite enrollment.\n')
  const workspaceId = loadOrCreateWorkspaceId()
  const routeHint = hashExecutorInviteRoute(invite)
  let acceptToken!: (token: string) => void
  const enrolledToken = new Promise<string>((resolveToken) => { acceptToken = resolveToken })
  const handle = startExecutor({ host, workspaceId, sandboxRoots: [workspaceRoot], invite, routeHint, logger, onToken(token) { acceptToken(token) } })
  let enrollmentTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    const timedOut = new Promise<never>((_, reject) => {
      enrollmentTimeout = setTimeout(() => reject(new Error('Executor invite enrollment timed out')), 90_000)
    })
    const enrollment = await Promise.race([Promise.all([handle.ready, enrolledToken]).then(([, token]) => ({ token })), handle.permanentError.then((error) => ({ error })), timedOut])
    if ('error' in enrollment) throw new Error(`Executor invite enrollment failed: ${enrollment.error.code}`)
    delete process.env.EXECUTOR_INVITE
    process.stdout.write('Private Cloud invited device enrolled.\n')
    await handle.close()
    process.stdout.write('Installing Private Cloud Windows service.\n')
    await installWindowsService({ HOST_URL: host, EXECUTOR_PRIVILEGE_MODE: 'privileged', EXECUTOR_INSTALL_ID: `invite-${routeHint}` }, workspaceRoot, enrollment.token, workspaceId, { routeHint, installationSource: 'private-cloud-invite', reportProgress: false })
  } finally {
    if (enrollmentTimeout) clearTimeout(enrollmentTimeout)
    delete process.env.EXECUTOR_INVITE
    await handle.close().catch(() => undefined)
  }
}

async function installWindowsService(env: Pick<ReturnType<typeof bootstrapEnvironment>, 'HOST_URL' | 'EXECUTOR_PRIVILEGE_MODE'> & Partial<Pick<ReturnType<typeof bootstrapEnvironment>, 'EXECUTOR_INSTALL_LABEL' | 'EXECUTOR_INSTALL_ID'>>, workspaceRoot: string, token: string, workspaceId: string, options: { routeHint?: string; installationSource?: 'dashboard-native' | 'private-cloud-invite'; reportProgress?: boolean } = {}): Promise<void> {
  const serviceName = 'KalaExecutor'
  const plan = createWindowsServicePlan({
    serviceName, displayName: 'Kala Executor',
    programFiles: process.env.ProgramFiles, programData: process.env.ProgramData,
  })
  if (basename(process.execPath).toLowerCase() === 'node.exe') throw new Error('Windows service mode requires the native kala-executor asset')
  if (existsSync(plan.layout.installDir) || existsSync(plan.layout.dataDir)) {
    throw new Error('Refusing to replace an existing Windows Executor installation or data directory')
  }
  mkdirSync(plan.layout.installDir, { recursive: true, mode: 0o700 })
  mkdirSync(plan.layout.dataDir, { recursive: true, mode: 0o700 })
  const credentialPath = join(plan.layout.dataDir, 'credential')
  const config = {
    version: 1, host: env.HOST_URL, ...(env.EXECUTOR_INSTALL_LABEL ? { name: env.EXECUTOR_INSTALL_LABEL } : {}),
    privilegeMode: env.EXECUTOR_PRIVILEGE_MODE,
    sandboxRoots: [workspaceRoot], credentialFile: credentialPath, installationId: env.EXECUTOR_INSTALL_ID,
    workspaceId, ...(options.routeHint ? { routeHint: options.routeHint } : {}), installationSource: options.installationSource ?? 'dashboard-native', managedRoot: plan.layout.dataDir, serviceMode: 'system',
  }
  try {
    await secureWindowsServiceDataDir(plan.layout.dataDir)
    copyFileSync(process.execPath, plan.layout.executablePath)
    copyWindowsNodePtyRuntime(dirname(process.execPath), plan.layout.installDir)
    copyWindowsServiceHost(dirname(process.execPath), plan.layout.installDir)
    writePrivateAtomic(plan.layout.serviceConfigPath, renderWindowsServiceConfig(plan.layout, serviceName, 'Kala Executor'))
    writePrivateAtomic(credentialPath, `${token}\n`)
    writePrivateAtomic(plan.layout.configPath, `${JSON.stringify(config, null, 2)}\n`)
    if (options.reportProgress !== false) await reportInstallation(env as ReturnType<typeof bootstrapEnvironment>, 'service_installing')
    if (options.reportProgress !== false) await reportInstallation(env as ReturnType<typeof bootstrapEnvironment>, 'starting')
    await executeWindowsServicePlan(plan, ['create', 'recovery', 'start'])
    process.stdout.write('[4/4] Windows service started and connected.\n')
    process.stdout.write(`  Status ${JSON.stringify(plan.layout.executablePath)} service status\n`)
    process.stdout.write(`  Uninstall ${JSON.stringify(plan.layout.executablePath)} service uninstall\n`)
  } catch (error) {
    await executeWindowsServicePlan(plan, ['stop']).catch(() => undefined)
    // Never remove a running service's executable or credentials. Preserve
    // the installation for diagnosis if SCM cannot confirm it stopped.
    await waitForWindowsServiceStopped(plan)
    await executeWindowsServicePlan(plan, ['delete']).catch(() => undefined)
    rmSync(plan.layout.installDir, { recursive: true, force: true }); rmSync(plan.layout.dataDir, { recursive: true, force: true })
    throw error
  }
}

function writePrivateAtomic(path: string, contents: string): void {
  const temporary = `${path}.tmp-${process.pid}`
  try { writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}

function writeTemporaryConfig(session: InstallerSession): string {
  const root = defaultManagedRoot(homedir(), false)
  const credential = join(root, 'temporary-credential')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(credential, `${session.credential.token}\n`, { mode: 0o600 })
  const config = join(root, 'temporary-config.json')
  writeFileSync(config, `${JSON.stringify({ version: 1, host: session.host, privilegeMode: session.privilegeMode, sandboxRoots: session.sandboxRoots, credentialFile: credential, installationId: session.installationId })}\n`, { mode: 0o600 })
  return config
}

async function runServiceCommand(command: Command): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject); child.once('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }))
    child.stdin.end(command.stdin)
  })
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const internalIndex = argv.findIndex((arg) => arg === '--internal-installer')
  if (internalIndex >= 0) {
    await runInternalInstaller()
    return
  }
  const inviteInstallerIndex = argv.findIndex((arg) => arg === '--invite-installer')
  if (inviteInstallerIndex >= 0) {
    if (argv.length !== 1) throw new Error('--invite-installer does not accept command-line credentials or options')
    await runInviteInstaller()
    return
  }
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return
  }
  if (args.version) {
    printVersion()
    return
  }

  if (args.command === 'service') {
    if (process.platform === 'win32') { await manageWindowsService(args.serviceAction!); return }
    if (process.platform !== 'linux') throw new Error('Executor service management is currently available on Linux and Windows only')
    const systemPaths = linuxServicePaths('system', homedir())
    const userPaths = linuxServicePaths('user', homedir())
    const mode = args.serviceMode ?? (existsSync(systemPaths.config) ? 'system' : existsSync(userPaths.config) ? 'user' : undefined)
    if (!mode) throw new Error('No managed Executor service was found. Install service mode from Add Workspace, or pass --system/--user explicitly.')
    const plan = createLinuxServicePlan(args.serviceAction!, mode, homedir())
    const results = await executeLinuxServicePlan(plan, { run: runServiceCommand })
    for (const result of results) {
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
    }
    if (args.serviceAction === 'uninstall') process.stdout.write('\nKala Executor service was removed.\n')
    else if (args.serviceAction !== 'logs' && args.serviceAction !== 'status') printServiceCommands(mode)
    return
  }

  const managed = args.config ? readExecutorRuntimeConfig(args.config) : undefined
  if (args.command === 'update') {
    if (!managed?.update?.enabled || !managed.managedRoot || !managed.serviceMode) throw new Error('managed updates are not configured for this Executor service')
    const workspaceId = loadOrCreateWorkspaceId(undefined, normalizeExecutorProfile(managed.profile))
    const common = { root: managed.managedRoot, serviceMode: managed.serviceMode, workspaceId, socketPath: join(managed.managedRoot, 'update-control.sock'), reconnectTimeoutMs: 60_000, logger }
    if (args.updateAction === 'rollback') await rollbackManagedUpdate(common)
    else {
      const result = await applyManagedUpdate({ ...common, manifestUrl: managed.update.manifestUrl, publicKeyPath: managed.update.publicKeyFile, currentVersion: executorReleaseVersion(), channel: managed.update.channel, protocol: Number(PROTOCOL_VERSION.split('.')[0]) })
      logger.info({ result }, 'managed Executor update finished')
    }
    return
  }
  const host = args.host ?? managed?.host ?? process.env.HOST_URL
  const name = args.name ?? managed?.name ?? process.env.WORKSPACE_NAME
  const envRoots = parseSandboxRootsEnv(process.env.SANDBOX_ROOTS)
  const sandboxRoots = args.sandboxRoots.length > 0 ? args.sandboxRoots : managed?.sandboxRoots ?? envRoots
  const managedCredential = managed ? readExecutorCredential(managed.credentialFile) : undefined
  const invite = args.invite ?? (managedCredential?.startsWith('ak_invite_') ? managedCredential : undefined) ?? process.env.EXECUTOR_INVITE
  const profile = normalizeExecutorProfile(args.profile ?? managed?.profile ?? process.env.KALA_EXECUTOR_PROFILE)
  const token = args.token ?? (managedCredential?.startsWith('ak_exec_') ? managedCredential : undefined) ?? process.env.EXECUTOR_TOKEN ?? loadExecutorToken(undefined, profile)
  const routeHint = invite ? hashExecutorInviteRoute(invite) : managed?.routeHint ?? (token ? loadExecutorRouteHint(profile) : undefined)
  // Previously enrolled Executors already have a device token, so Host does not issue
  // another welcome. Preserve their invite's routing hint before the first reconnect.
  if (invite && token) saveExecutorRouteHint(invite, profile)
  const executorId = args.id ?? process.env.EXECUTOR_ID
  const autoUpdate = args.autoUpdate === true || process.env.KALA_AUTO_UPDATE === '1'
  const noUpdateCheck = args.noUpdateCheck === true || process.env.KALA_NO_UPDATE_CHECK === '1'
  const updateRepo = args.updateRepo ?? process.env.KALA_UPDATE_REPO
  const mcpServers = args.mcpServers.length > 0
    ? parseMcpServers(args.mcpServers, '--mcp')
    : managed
      ? managed.mcpServers ?? []
      : parseMcpServers(process.env.MCP_SERVERS)
  const managedMcpConfig = args.config && managed?.installationSource === 'dashboard-native' &&
    typeof managed.installationId === 'string' && managed.installationId.length > 0 &&
    args.mcpServers.length === 0 && process.env.MCP_SERVERS === undefined
    ? {
        path: resolve(args.config),
        installationSource: 'dashboard-native' as const,
        installationId: managed.installationId,
        configurationSource: 'managed-config' as const,
      }
    : undefined

  if (!host) {
    logger.error(
      {
        flag: '--host',
        env: 'HOST_URL',
        example: 'HOST_URL=http://localhost:3000 EXECUTOR_INVITE=ak_invite_... node kala-executor.cjs',
      },
      'missing host url',
    )
    process.exit(1)
  }

  let pairingToken = token
  if (!invite && !pairingToken) {
    const workspaceId = loadOrCreateWorkspaceId(undefined, profile)
    const pairingUrl = `${host.replace(/\/$/u, '')}/auth/executor-pairings`
    const response = await fetch(pairingUrl, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ workspaceId, label: name }) })
    const pairing = await readPairingJson<{ id: string; claimSecret: string; code: string; expiresAt: string }>(response, 'start pairing', pairingUrl)
    logger.info({ code: pairing.code, expiresAt: pairing.expiresAt }, 'approve this executor in Kala')
    while (Date.now() < Date.parse(pairing.expiresAt)) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const claimUrl = `${host.replace(/\/$/u, '')}/auth/executor-pairings/${encodeURIComponent(pairing.id)}/claim`
      const claim = await fetch(claimUrl, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ claimSecret: pairing.claimSecret }) })
      if (claim.status === 404) continue
      const result = await readPairingJson<{ status: string; token?: string }>(claim, 'check pairing approval', claimUrl)
      if (result.token) { pairingToken = result.token; saveExecutorToken(result.token, undefined, profile); break }
      if (result.status === 'rejected' || result.status === 'expired') throw new Error(`pairing ${result.status}`)
    }
    if (!pairingToken) throw new Error('pairing expired')
  }
  const authKind = invite ? 'invite' : pairingToken ? 'token' : 'none'
  const rootsLabel = sandboxRoots.length > 0 ? sandboxRoots.join(':') : '<no jail>'
  const profileLabel = profile ?? 'default'
  logger.info(
    { host, auth: authKind, profile: profileLabel, workspace: name ?? '<hostname>', sandbox: rootsLabel },
    'connecting to host',
  )

  // Local single-instance lock for this profile. Different profiles get
  // distinct workspace ids and token files, so a dev machine can run one
  // release executor and one isolated test executor at the same time.
  const lockPath = await acquireLocalLock(logger, profile)
  process.on('exit', () => {
    // Best-effort release. proper-lockfile also survives crashes via mtime
    // staleness so we don't panic if this doesn't run.
    void lockfile.unlock(lockPath, { realpath: false }).catch(() => undefined)
  })

  if (updateRepo && !noUpdateCheck && process.env.KALA_SKIP_UPDATE_ONCE !== '1') {
    try {
      await checkExecutorUpdate({
        repo: updateRepo,
        currentTag: process.env.KALA_RELEASE_TAG,
        autoUpdate,
        argv: process.argv.slice(2),
        logger,
      })
    } catch (err) {
      logger.warn({ err }, 'executor update check failed')
    }
  }

  const workspaceId = managed?.workspaceId ?? loadOrCreateWorkspaceId(undefined, profile)
  const workspaceName = name ?? hostname()
  const effectiveExecutorId = executorId ?? ulid()
  const saveToken = (nextToken: string): void => {
    saveExecutorToken(nextToken, undefined, profile)
    if (invite) saveExecutorRouteHint(invite, profile)
    logger.info('executor identity saved for future reconnects')
  }
  const commonOptions = {
    host,
    workspaceId,
    workspaceName,
    ...(sandboxRoots.length > 0 ? { sandboxRoots } : {}),
    executorId: effectiveExecutorId,
    ...(managed?.installationId ? { installId: managed.installationId } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(managedMcpConfig ? { managedMcpConfig } : {}),
    logger,
  }
  const replicas = await discoverExecutorReplicas({ host, ...(invite ? { invite } : {}), ...(routeHint ? { routeHint } : {}) })
  if (replicas && replicas.length === 0) throw new Error('No active Runtime replicas are available for this Executor route')
  let fleetToken = pairingToken
  if (replicas?.length && invite && !fleetToken) {
    let resolveEnrollment!: (token: string) => void
    const enrolled = new Promise<string>((resolve) => { resolveEnrollment = resolve })
    const enrollment = startExecutor({
      ...commonOptions,
      invite,
      ...(routeHint ? { routeHint } : {}),
      replicaId: replicas[0],
      onToken(nextToken) { saveToken(nextToken); resolveEnrollment(nextToken) },
    })
    const enrollmentResult = await Promise.race([
      enrolled.then((nextToken) => ({ token: nextToken })),
      enrollment.permanentError.then((error) => ({ error })),
    ])
    await enrollment.close()
    if ('error' in enrollmentResult) throw new Error(`Executor enrollment failed: ${enrollmentResult.error.message}`)
    fleetToken = enrollmentResult.token
  }
  const handle = replicas?.length && fleetToken && routeHint
    ? startExecutorReplicaFleet({
        ...commonOptions,
        token: fleetToken,
        routeHint,
        replicaIds: replicas,
        refreshReplicaIds: () => discoverExecutorReplicas({ host, routeHint }),
      })
    : startExecutor({
        ...commonOptions,
        ...(pairingToken !== undefined ? { token: pairingToken } : {}),
        ...(invite !== undefined ? { invite } : {}),
        ...(routeHint !== undefined ? { routeHint } : {}),
        onToken: saveToken,
      })

  if ('socket' in handle) {
    handle.socket.on('connect', () => {
      logger.debug({ executorId: effectiveExecutorId, workspaceId, workspaceName, host }, 'executor connection details')
    })
  } else {
    logger.info({ replicas: handle.replicaIds() }, 'connecting Executor to active Runtime replicas')
  }

  // MCP subprocesses can start before the Host becomes reachable. Register
  // cleanup immediately instead of leaving children behind during that wait.
  let updateControl: Awaited<ReturnType<typeof startUpdateControlServer>> | null = null
  let stopping = false
  const shutdown = async (code = 0): Promise<void> => {
    if (stopping) return
    stopping = true
    logger.info('shutting down')
    await Promise.allSettled([handle.close(), updateControl?.close() ?? Promise.resolve()])
    process.exit(code)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })

  const exitCodeByReason: Record<string, number> = {
    workspace_id_conflict: 2,
    workspace_identity_mismatch: 2,
    version_incompatible: 3,
    auth_failed: 4,
  }
  try {
    // A handshake can permanently reject the socket before `ready` resolves.
    // Race it now so authentication failures do not strand MCP subprocesses.
    const initialFailure = await Promise.race([handle.ready.then(() => null), handle.permanentError])
    if (initialFailure) {
      logger.error({ failure: initialFailure }, 'executor rejected before announcement')
      await shutdown(exitCodeByReason[initialFailure.code] ?? 1)
      return
    }
    logger.info({ workspaceId, workspaceName, host, sandboxRoots, ...(!('socket' in handle) ? { replicas: handle.replicaIds() } : {}) }, 'executor announced; awaiting tool calls')
    if (!managed?.serviceMode) printForegroundCommands()
    updateControl = managed?.managedRoot && process.platform !== 'win32'
    ? await startUpdateControlServer({
        socketPath: join(managed.managedRoot, 'update-control.sock'),
        status: () => ({
          version: executorReleaseVersion(), workspaceId,
          connected: 'socket' in handle ? handle.socket.connected : handle.connected(), draining: handle.draining(),
          activeTools: handle.activeToolCount(), activeTerminals: handle.activeTerminalCount(),
        }),
        beginDrain: () => handle.beginDrain(),
        resume: () => handle.resume(),
      })
    : null

    // Wait for a permanent error signal from the wire layer. This resolves
    // only when the host explicitly rejects this executor's identity, auth, or
    // protocol version. Transport failures are daemon-normal: socket.io keeps
    // reconnecting with exponential backoff until the process is stopped.
    const failure = await handle.permanentError
    const code = exitCodeByReason[failure.code] ?? 1
    logger.error(
      { failure },
      `executor stopping — this is a permanent failure that will not self-heal. ` +
        `See message above for instructions.`,
    )
    await shutdown(code)
  } catch (error) {
    // The outer CLI error handler exits the process; release stdio children
    // before that path runs too.
    await Promise.allSettled([handle.close(), updateControl?.close() ?? Promise.resolve()])
    throw error
  }
}

async function manageWindowsService(action: Exclude<ServiceAction, 'install'>): Promise<void> {
  const plan = createWindowsServicePlan({ serviceName: 'KalaExecutor', displayName: 'Kala Executor', programFiles: process.env.ProgramFiles, programData: process.env.ProgramData })
  if (action === 'logs') {
    process.stdout.write(`Windows service output: ${join(plan.layout.installDir, 'kala-executor-service.out.log')}\n`)
    process.stdout.write(`Windows service errors: ${join(plan.layout.installDir, 'kala-executor-service.err.log')}\n`)
    return
  }
  const actions: readonly WindowsServiceAction[] = action === 'status' ? ['query'] : action === 'start' ? ['start'] : action === 'stop' ? ['stop'] : action === 'restart' ? ['stop', 'start'] : ['stop', 'delete']
  if (action === 'uninstall') {
    if (!existsSync(plan.layout.configPath)) throw new Error('No managed Windows Executor service configuration was found')
    assertManagedWindowsInstallation(JSON.parse(readFileSync(plan.layout.configPath, 'utf8')))
  }
  let results
  if (action === 'uninstall' || action === 'restart') {
    await executeWindowsServicePlan(plan, ['stop']).catch(() => undefined)
    await waitForWindowsServiceStopped(plan)
    results = await executeWindowsServicePlan(plan, actions.slice(1))
  } else {
    results = await executeWindowsServicePlan(plan, actions)
    if (action === 'stop') await waitForWindowsServiceStopped(plan)
  }
  for (const result of results) { if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr) }
  if (action === 'uninstall') {
    if (resolve(process.execPath).startsWith(`${resolve(plan.layout.installDir)}${sep}`)) {
      const statusFile = await scheduleWindowsSelfRemoval(plan.layout.installDir, plan.layout.dataDir)
      process.stdout.write('\nKala Executor Windows service removal was scheduled. Program files and credentials will be removed after this process exits.\n')
      process.stdout.write(`Removal status file: ${statusFile}\n`)
    } else {
      rmSync(plan.layout.dataDir, { recursive: true, force: true })
      rmSync(plan.layout.installDir, { recursive: true, force: true })
      process.stdout.write('\nKala Executor Windows service and credentials were removed.\n')
    }
  }
}

async function scheduleWindowsSelfRemoval(installDir: string, dataDir: string): Promise<string> {
  const removal = createWindowsSelfRemovalPlan({ installDir, dataDir, ownerPid: process.pid, statusDir: tmpdir() })
  let registered = false
  try {
    writeFileSync(removal.statusPath, 'queued', { mode: 0o600, flag: 'wx' })
    // dataDir was ACL-hardened to SYSTEM and Administrators before credentials
    // were installed. Keep the privileged task definition inside that boundary.
    writeFileSync(removal.taskXmlPath, encodeWindowsTaskXml(removal.taskXml), { mode: 0o600, flag: 'wx' })
    await registerWindowsSelfRemovalTask(removal)
    registered = true
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const status = readFileSync(removal.statusPath, 'utf8')
      if (status.startsWith('failed:')) throw new Error(`Windows removal task failed during startup (${status.slice('failed:'.length)})`)
      if (status !== 'queued') return basename(removal.statusPath)
      await new Promise((resolveReady) => setTimeout(resolveReady, 100))
    }
    throw new Error('Windows removal task did not confirm startup')
  } catch (error) {
    if (registered) await deleteWindowsSelfRemovalTask(removal.taskName).catch(() => undefined)
    throw error
  } finally {
    // Task Scheduler has copied the definition by this point. The encoded task
    // action remains registered/running and does not read this XML at runtime.
    rmSync(removal.taskXmlPath, { force: true })
  }
}

main().catch((err) => {
  logger.error({ err }, 'fatal error')
  process.exit(1)
})
