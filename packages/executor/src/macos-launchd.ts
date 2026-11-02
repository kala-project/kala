export type LaunchdScope = 'system' | 'user'
export type LaunchdArchitecture = 'x64' | 'arm64'
export type LaunchdPlanName =
  | 'install'
  | 'bootstrap'
  | 'bootout'
  | 'kickstart'
  | 'status'
  | 'logs'
  | 'uninstall'

export type LaunchdCommandOperation = {
  kind: 'command'
  executable: string
  args: readonly string[]
  /** A missing/already loaded service is harmless for convergence operations. */
  allowFailure?: boolean
}

export type LaunchdWriteFileOperation = {
  kind: 'write-file'
  path: string
  content: string
  mode: 0o644
  atomic: true
  skipIfUnchanged: true
}

export type LaunchdRemoveFileOperation = {
  kind: 'remove-file'
  path: string
  missingOk: true
}

export type LaunchdOperation =
  | LaunchdCommandOperation
  | LaunchdWriteFileOperation
  | LaunchdRemoveFileOperation

export type LaunchdPlanStep = {
  id: string
  operation: LaunchdOperation
  rollback?: LaunchdOperation
}

export type LaunchdPlan = {
  version: 1
  name: LaunchdPlanName
  steps: readonly LaunchdPlanStep[]
}

export type LaunchdServicePlans = Record<LaunchdPlanName, LaunchdPlan>

export type LaunchdServiceDefinition = {
  scope: LaunchdScope
  architecture: LaunchdArchitecture
  label: string
  domain: string
  serviceTarget: string
  executablePath: string
  configPath: string
  plistPath: string
  stdoutPath: string
  stderrPath: string
  plist: string
  plans: LaunchdServicePlans
}

export type CreateLaunchdServiceOptions = {
  scope: LaunchdScope
  architecture: LaunchdArchitecture
  configPath: string
  /** Required for a LaunchAgent. Used for gui/<uid>, never written to ProgramArguments. */
  uid?: number
  /** Required for a LaunchAgent so no ambient HOME lookup affects generated output. */
  homeDirectory?: string
  label?: string
  executablePath?: string
  executableSearchPath?: string
}

export type LaunchdOperationExecutor<T = unknown> = (
  operation: LaunchdOperation,
) => T | Promise<T>

const LAUNCHCTL = '/bin/launchctl'
const LOG = '/usr/bin/log'
const TAIL = '/usr/bin/tail'
const DEFAULT_LABEL = 'com.agentrunlab.executor'

function assertAbsolutePath(name: string, value: string): void {
  if (!value.startsWith('/') || value.includes('\0')) {
    throw new Error(`${name} must be an absolute path without NUL bytes`)
  }
}

function assertLabel(label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(label)) {
    throw new Error(`Invalid launchd label ${JSON.stringify(label)}`)
  }
}

/** Escapes text for an XML element without altering Unicode code points. */
export function escapeLaunchdXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function command(executable: string, args: readonly string[], allowFailure = false): LaunchdCommandOperation {
  return { kind: 'command', executable, args, ...(allowFailure ? { allowFailure: true } : {}) }
}

function plan(name: LaunchdPlanName, steps: readonly LaunchdPlanStep[]): LaunchdPlan {
  return { version: 1, name, steps }
}

/**
 * Purely generates a launchd definition and convergent operation plans. It does
 * not inspect the host or invoke launchctl, making it safe to call on Linux.
 */
export function createMacosLaunchdService(
  options: CreateLaunchdServiceOptions,
): LaunchdServiceDefinition {
  const label = options.label ?? DEFAULT_LABEL
  assertLabel(label)
  assertAbsolutePath('configPath', options.configPath)

  const executablePath = options.executablePath ?? (
    options.architecture === 'arm64'
      ? '/opt/homebrew/bin/kala-executor'
      : '/usr/local/bin/kala-executor'
  )
  assertAbsolutePath('executablePath', executablePath)

  let domain: string
  let plistPath: string
  let logDirectory: string
  if (options.scope === 'system') {
    domain = 'system'
    plistPath = `/Library/LaunchDaemons/${label}.plist`
    logDirectory = '/Library/Logs/Kala'
  } else {
    if (!Number.isSafeInteger(options.uid) || (options.uid ?? -1) < 0) {
      throw new Error('uid must be a non-negative integer for a user LaunchAgent')
    }
    if (!options.homeDirectory) throw new Error('homeDirectory is required for a user LaunchAgent')
    assertAbsolutePath('homeDirectory', options.homeDirectory)
    domain = `gui/${options.uid}`
    plistPath = `${options.homeDirectory}/Library/LaunchAgents/${label}.plist`
    logDirectory = `${options.homeDirectory}/Library/Logs/Kala`
  }

  const serviceTarget = `${domain}/${label}`
  const stdoutPath = `${logDirectory}/executor.log`
  const stderrPath = `${logDirectory}/executor.error.log`
  const xml = escapeLaunchdXml
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  ${options.executableSearchPath ? `<key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(options.executableSearchPath)}</string></dict>` : ''}
  <key>ProgramArguments</key>
  <array>
    <string>${xml(executablePath)}</string>
    <string>--config</string>
    <string>${xml(options.configPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrPath)}</string>
</dict>
</plist>
`

  const bootoutOperation = command(LAUNCHCTL, ['bootout', serviceTarget], true)
  const bootstrapOperation = command(LAUNCHCTL, ['bootstrap', domain, plistPath])
  const kickstartOperation = command(LAUNCHCTL, ['kickstart', '-k', serviceTarget])
  const writeOperation: LaunchdWriteFileOperation = {
    kind: 'write-file', path: plistPath, content: plist, mode: 0o644, atomic: true, skipIfUnchanged: true,
  }
  const removeOperation: LaunchdRemoveFileOperation = { kind: 'remove-file', path: plistPath, missingOk: true }

  const plans: LaunchdServicePlans = {
    bootstrap: plan('bootstrap', [
      { id: 'bootstrap', operation: bootstrapOperation, rollback: bootoutOperation },
    ]),
    bootout: plan('bootout', [
      { id: 'bootout', operation: bootoutOperation, rollback: bootstrapOperation },
    ]),
    kickstart: plan('kickstart', [
      { id: 'kickstart', operation: kickstartOperation },
    ]),
    status: plan('status', [
      { id: 'status', operation: command(LAUNCHCTL, ['print', serviceTarget]) },
    ]),
    logs: plan('logs', [
      { id: 'stdout', operation: command(TAIL, ['-n', '200', stdoutPath], true) },
      { id: 'stderr', operation: command(TAIL, ['-n', '200', stderrPath], true) },
      { id: 'unified-log', operation: command(LOG, ['show', '--style', 'compact', '--last', '1h', '--predicate', `process == "${executablePath.split('/').at(-1)}"`], true) },
    ]),
    install: plan('install', [
      { id: 'bootout-existing', operation: bootoutOperation },
      { id: 'write-plist', operation: writeOperation, rollback: removeOperation },
      { id: 'bootstrap', operation: bootstrapOperation, rollback: bootoutOperation },
      { id: 'kickstart', operation: kickstartOperation },
    ]),
    uninstall: plan('uninstall', [
      { id: 'bootout', operation: bootoutOperation, rollback: bootstrapOperation },
      { id: 'remove-plist', operation: removeOperation, rollback: writeOperation },
    ]),
  }

  return {
    scope: options.scope,
    architecture: options.architecture,
    label,
    domain,
    serviceTarget,
    executablePath,
    configPath: options.configPath,
    plistPath,
    stdoutPath,
    stderrPath,
    plist,
    plans,
  }
}

/** Executes a generated plan through an injected operation boundary. */
export async function executeLaunchdPlan<T>(
  planToExecute: LaunchdPlan,
  execute: LaunchdOperationExecutor<T>,
): Promise<readonly T[]> {
  const completed: LaunchdPlanStep[] = []
  const results: T[] = []
  try {
    for (const step of planToExecute.steps) {
      results.push(await execute(step.operation))
      completed.push(step)
    }
    return results
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const step of completed.reverse()) {
      if (!step.rollback) continue
      try {
        await execute(step.rollback)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], `launchd ${planToExecute.name} failed and rollback was incomplete`)
    }
    throw error
  }
}
