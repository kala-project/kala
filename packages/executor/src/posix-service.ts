import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ServiceMode } from './cli-args.js'
import { renderExecutorServiceConfig, type InstallerSession } from './installer-session.js'
import { createLinuxServicePlan, executeLinuxServicePlan, type CommandRunner } from './linux-service.js'
import { createMacosLaunchdService, executeLaunchdPlan, type LaunchdOperation, type LaunchdPlanName } from './macos-launchd.js'

type Options = { platform: NodeJS.Platform; architecture: string; home: string; uid?: number; runner: CommandRunner }

export function macosServiceDefinition(mode: ServiceMode, options: Omit<Options, 'runner' | 'platform'>, executablePath?: string) {
  if (options.architecture !== 'x64' && options.architecture !== 'arm64') throw new Error('Unsupported macOS service architecture')
  const root = mode === 'system' ? '/var/lib/kala/executor' : join(options.home, '.local/state/kala/executor')
  return createMacosLaunchdService({
    scope: mode, architecture: options.architecture, configPath: join(root, 'config.json'),
    ...(mode === 'user' ? { uid: options.uid, homeDirectory: options.home } : {}),
    ...(executablePath ? { executablePath } : {}),
    label: 'com.kala.executor',
    executableSearchPath: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  })
}

async function executeMacosOperation(operation: LaunchdOperation, runner: CommandRunner): Promise<void> {
  if (operation.kind === 'write-file') {
    mkdirSync(dirname(operation.path), { recursive: true })
    const temporary = `${operation.path}.tmp-${process.pid}`
    try {
      writeFileSync(temporary, operation.content, { mode: operation.mode, flag: 'wx' })
      renameSync(temporary, operation.path)
    } finally { rmSync(temporary, { force: true }) }
  } else if (operation.kind === 'remove-file') {
    rmSync(operation.path, { force: operation.missingOk })
  } else {
    const result = await runner.run({ file: operation.executable, args: operation.args, allowFailure: operation.allowFailure })
    if (result.code !== 0 && !operation.allowFailure) throw new Error(`launchd command failed (${result.code}): ${result.stderr}`)
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr && result.code !== 0 && !operation.allowFailure) process.stderr.write(result.stderr)
  }
}

export async function installPosixService(session: InstallerSession, options: Options): Promise<void> {
  if (options.platform === 'linux') {
    await executeLinuxServicePlan(createLinuxServicePlan('install', session.mode, options.home, session), options.runner)
    return
  }
  if (options.platform !== 'darwin') throw new Error('Unsupported POSIX service platform')
  if (session.privilegeMode === 'restricted') throw new Error('Restricted services are supported on Linux only')
  const definition = macosServiceDefinition(session.mode, options, session.executable)
  if (existsSync(definition.plistPath) || existsSync(definition.configPath)) throw new Error('Refusing to replace an existing macOS Executor service')
  const root = dirname(definition.configPath)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  mkdirSync(dirname(definition.stdoutPath), { recursive: true, mode: 0o700 })
  const credentialFile = join(root, 'credential')
  writeFileSync(credentialFile, `${session.credential.token ?? session.credential.invite}\n`, { mode: 0o600, flag: 'wx' })
  writeFileSync(definition.configPath, renderExecutorServiceConfig(session, credentialFile), { mode: 0o600, flag: 'wx' })
  await executeLaunchdPlan(definition.plans.install, async operation => await executeMacosOperation(operation, options.runner))
}

export async function manageMacosService(action: LaunchdPlanName, mode: ServiceMode, options: Options): Promise<void> {
  const definition = macosServiceDefinition(mode, options)
  await executeLaunchdPlan(definition.plans[action], async operation => await executeMacosOperation(operation, options.runner))
}
