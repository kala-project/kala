import { dirname, join } from 'node:path'

import { renderExecutorServiceConfig, type InstallerSession } from './installer-session.js'
import type { ServiceAction, ServiceMode } from './cli-args.js'

export type Command = {
  file: string
  args: readonly string[]
  stdin?: string
  allowFailure?: boolean
}

export type CommandResult = { code: number; stdout: string; stderr: string }
export type CommandRunner = { run(command: Command): Promise<CommandResult> }

export type LinuxServicePaths = {
  unit: string
  config: string
  credential: string
  serviceName: string
  updateUnit: string
  updateTimer: string
}

export type LinuxServicePlan = {
  action: ServiceAction
  mode: ServiceMode
  paths: LinuxServicePaths
  commands: readonly Command[]
  rollback: readonly Command[]
}

const SERVICE_NAME = 'kala-executor.service'

function systemctl(mode: ServiceMode, ...args: string[]): Command {
  return { file: 'systemctl', args: [...(mode === 'user' ? ['--user'] : []), ...args] }
}

function journalctl(mode: ServiceMode): Command {
  return { file: 'journalctl', args: [...(mode === 'user' ? ['--user'] : []), '--unit', SERVICE_NAME, '--follow'] }
}

export function linuxServicePaths(mode: ServiceMode, home: string): LinuxServicePaths {
  return mode === 'system'
    ? {
        serviceName: SERVICE_NAME,
        unit: `/etc/systemd/system/${SERVICE_NAME}`,
        config: '/etc/kala/executor/config.json',
        credential: '/etc/kala/executor/credential',
        updateUnit: '/etc/systemd/system/kala-executor-update.service',
        updateTimer: '/etc/systemd/system/kala-executor-update.timer',
      }
    : {
        serviceName: SERVICE_NAME,
        unit: join(home, '.config', 'systemd', 'user', SERVICE_NAME),
        config: join(home, '.config', 'kala', 'executor', 'config.json'),
        credential: join(home, '.config', 'kala', 'executor', 'credential'),
        updateUnit: join(home, '.config', 'systemd', 'user', 'kala-executor-update.service'),
        updateTimer: join(home, '.config', 'systemd', 'user', 'kala-executor-update.timer'),
      }
}

export function renderLinuxServiceFiles(session: InstallerSession, home: string): {
  paths: LinuxServicePaths
  unit: string
  config: string
  credential: string
  updateUnit?: string
  updateTimer?: string
} {
  const paths = linuxServicePaths(session.mode, home)
  const servicePath = `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
  const config = renderExecutorServiceConfig(session, paths.credential)
  const credential = session.credential.token
    ? `${session.credential.token}\n`
    : `${session.credential.invite!}\n`
  const unit = `[Unit]
Description=Kala Executor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=${systemdQuote(`PATH=${servicePath}`)}
ExecStart=${systemdQuote(session.executable)} --config ${systemdQuote(paths.config)}
Restart=always
RestartSec=5s
TimeoutStopSec=90s
KillMode=control-group
UMask=0077
CPUAccounting=yes
CPUQuota=400%
MemoryAccounting=yes
MemoryMax=8G
TasksMax=512
LimitFSIZE=1073741824
NoNewPrivileges=${session.privilegeMode === 'restricted' ? 'yes' : 'no'}

[Install]
WantedBy=${session.mode === 'system' ? 'multi-user.target' : 'default.target'}
`
  const updateUnit = session.update ? `[Unit]
Description=Kala Executor managed update
After=network-online.target kala-executor.service

[Service]
Type=oneshot
Environment=${systemdQuote(`PATH=${servicePath}`)}
ExecStart=${systemdQuote(session.executable)} update apply --config ${systemdQuote(paths.config)}
` : undefined
  const updateTimer = session.update ? `[Unit]
Description=Check for Kala Executor updates

[Timer]
OnBootSec=5min
OnUnitActiveSec=${session.update.intervalMinutes}min
RandomizedDelaySec=5min
Persistent=true

[Install]
WantedBy=timers.target
` : undefined
  return { paths, unit, config, credential, ...(updateUnit ? { updateUnit } : {}), ...(updateTimer ? { updateTimer } : {}) }
}

function systemdQuote(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) throw new Error('Invalid service argument')
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function privateWrite(path: string, contents: string): Command {
  // Content is sent over stdin and never appears in argv or diagnostics. Do not
  // use `install /dev/stdin`: Node supplies stdin as an anonymous pipe, and GNU
  // install tries to reopen /dev/stdin, which fails with ENXIO for that pipe.
  // Pass the destination as a positional parameter so it is never shell-parsed.
  return {
    file: 'sh',
    args: [
      '-c',
      'set -eu; target=$1; parent=${target%/*}; [ "$parent" = "$target" ] || mkdir -p -- "$parent"; umask 077; tmp="${target}.tmp.$$"; trap \'rm -f -- "$tmp"\' EXIT HUP INT TERM; cat > "$tmp"; chmod 0600 -- "$tmp"; mv -f -- "$tmp" "$target"; trap - EXIT HUP INT TERM',
      'kala-private-write',
      path,
    ],
    stdin: contents,
  }
}

export function createLinuxServicePlan(
  action: ServiceAction,
  mode: ServiceMode,
  home: string,
  session?: InstallerSession,
): LinuxServicePlan {
  const paths = linuxServicePaths(mode, home)
  if (action === 'status') return { action, mode, paths, commands: [{ ...systemctl(mode, 'status', SERVICE_NAME), allowFailure: true }], rollback: [] }
  if (action === 'logs') return { action, mode, paths, commands: [journalctl(mode)], rollback: [] }
  if (action === 'start') return { action, mode, paths, commands: [systemctl(mode, 'start', SERVICE_NAME)], rollback: [] }
  if (action === 'stop') return { action, mode, paths, commands: [systemctl(mode, 'stop', SERVICE_NAME)], rollback: [] }
  if (action === 'restart') return { action, mode, paths, commands: [systemctl(mode, 'restart', SERVICE_NAME)], rollback: [] }
  if (action === 'uninstall') {
    return {
      action, mode, paths,
      commands: [
        { ...systemctl(mode, 'disable', '--now', SERVICE_NAME), allowFailure: true },
        { ...systemctl(mode, 'disable', '--now', 'kala-executor-update.timer'), allowFailure: true },
        { file: 'rm', args: ['-f', paths.unit, paths.config, paths.credential, paths.updateUnit, paths.updateTimer] },
        systemctl(mode, 'daemon-reload'),
      ],
      rollback: [],
    }
  }
  if (!session || session.mode !== mode) throw new Error('Install requires a matching installer session')
  const rendered = renderLinuxServiceFiles(session, home)
  return {
    action, mode, paths,
    commands: [
      // Fail closed when the name belongs to a unit outside the managed path.
      { ...systemctl(mode, 'show', SERVICE_NAME, '--property=LoadState,FragmentPath,MainPID'), allowFailure: true },
      privateWrite(paths.config, rendered.config),
      privateWrite(paths.credential, rendered.credential),
      privateWrite(paths.unit, rendered.unit),
      ...(rendered.updateUnit && rendered.updateTimer ? [privateWrite(paths.updateUnit, rendered.updateUnit), privateWrite(paths.updateTimer, rendered.updateTimer)] : []),
      systemctl(mode, 'daemon-reload'),
      systemctl(mode, 'enable', SERVICE_NAME),
      systemctl(mode, 'restart', SERVICE_NAME),
      ...(rendered.updateTimer ? [systemctl(mode, 'enable', '--now', 'kala-executor-update.timer')] : []),
    ],
    rollback: [
      { ...systemctl(mode, 'disable', '--now', SERVICE_NAME), allowFailure: true },
      { ...systemctl(mode, 'disable', '--now', 'kala-executor-update.timer'), allowFailure: true },
      { file: 'rm', args: ['-f', paths.unit, paths.config, paths.credential, paths.updateUnit, paths.updateTimer] },
      systemctl(mode, 'daemon-reload'),
    ],
  }
}

function assertManagedUnit(result: CommandResult, expectedPath: string): void {
  if (result.code !== 0) return
  const fields = Object.fromEntries(result.stdout.split('\n').map((line) => line.split('=', 2) as [string, string]))
  if (fields.LoadState === 'not-found') return
  if (fields.LoadState !== 'loaded' || fields.FragmentPath !== expectedPath) {
    throw new Error(`Refusing to replace unknown service at ${fields.FragmentPath || '<unknown>'}`)
  }
  const pid = Number.parseInt(fields.MainPID ?? '0', 10)
  if (!Number.isSafeInteger(pid) || pid < 0) throw new Error('Refusing service with an unknown process state')
}

/** Executes only through the injected runner and rolls a partial install back. */
export async function executeLinuxServicePlan(plan: LinuxServicePlan, runner: CommandRunner): Promise<readonly CommandResult[]> {
  const results: CommandResult[] = []
  try {
    for (let index = 0; index < plan.commands.length; index++) {
      const command = plan.commands[index]!
      const result = await runner.run(command)
      results.push(result)
      if (plan.action === 'install' && index === 0) assertManagedUnit(result, plan.paths.unit)
      if (result.code !== 0 && !command.allowFailure) throw new Error(`${command.file} failed: ${result.stderr.trim()}`)
    }
    return results
  } catch (error) {
    if (plan.action === 'install' && results.length > 1) {
      for (const command of plan.rollback) await runner.run(command).catch(() => undefined)
    }
    throw error
  }
}
