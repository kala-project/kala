import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createLinuxServicePlan, executeLinuxServicePlan, renderLinuxServiceFiles } from './linux-service.js'
import { createMacosLaunchdService, executeLaunchdPlan } from './macos-launchd.js'
import { assertElevatedWindowsAdministrator, assertManagedWindowsInstallation, copyWindowsNodePtyRuntime, copyWindowsServiceHost, createWindowsSelfRemovalPlan, createWindowsServicePlan, encodeWindowsTaskXml, executeWindowsServicePlan, registerWindowsSelfRemovalTask, renderWindowsServiceConfig, secureWindowsServiceDataDir, waitForWindowsServiceStopped, WINDOWS_NODE_PTY_RUNTIME_FILES } from './windows-service.js'
import type { InstallerSession } from './installer-session.js'

const session: InstallerSession = {
  version: 1,
  mode: 'system',
  privilegeMode: 'privileged',
  executable: '/opt/kala/executor/current/kala-executor',
  host: 'https://agent.example.test',
  name: 'Build Box',
  sandboxRoots: ['/srv/work space'],
  credential: { token: 'secret-value' },
}

describe('Linux service adapter', () => {
  it('writes private files through a real Node stdin pipe without exposing contents in argv', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runlab-linux-service-write-'))
    try {
      const privateSession: InstallerSession = {
        ...session,
        mode: 'user',
        executable: join(root, 'kala-executor'),
        credential: { token: 'real-pipe-secret' },
      }
      const plan = createLinuxServicePlan('install', 'user', root, privateSession)
      const writes = plan.commands.filter((command) => command.stdin !== undefined)
      expect(writes).toHaveLength(3)
      for (const command of writes) {
        expect(command.args.join(' ')).not.toContain('real-pipe-secret')
        const result = await spawnCommand(command)
        expect(result.code, result.stderr).toBe(0)
      }
      expect(readFileSync(plan.paths.credential, 'utf8')).toBe('real-pipe-secret\n')
      expect(statSync(plan.paths.credential).mode & 0o777).toBe(0o600)
      expect(readFileSync(plan.paths.unit, 'utf8')).toContain('kala-executor')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps credentials out of the unit and rolls partial installation back', async () => {
    const rendered = renderLinuxServiceFiles(session, '/home/example')
    expect(rendered.unit).not.toContain('secret-value')
    expect(rendered.unit).toContain('Restart=always')
    expect(rendered.unit).toContain(`Environment="PATH=${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"`)
    expect(rendered.unit).toContain('CPUQuota=400%')
    expect(rendered.unit).toContain('MemoryMax=8G')
    expect(rendered.unit).toContain('TasksMax=512')
    expect(rendered.unit).toContain('NoNewPrivileges=no')
    expect(JSON.parse(rendered.config).privilegeMode).toBe('privileged')
    expect(rendered.credential).toContain('secret-value')

    const plan = createLinuxServicePlan('install', 'system', '/home/example', session)
    const seen: string[] = []
    const runner = {
      run: vi.fn(async (command: { file: string; args: readonly string[]; allowFailure?: boolean }) => {
        seen.push(`${command.file} ${command.args.join(' ')}`)
        if (command.file === 'systemctl' && command.args.includes('show')) return { code: 0, stdout: 'LoadState=not-found\nFragmentPath=\nMainPID=0\n', stderr: '' }
        if (command.file === 'systemctl' && command.args.includes('enable')) return { code: 1, stdout: '', stderr: 'boom' }
        return { code: 0, stdout: '', stderr: '' }
      }),
    }
    await expect(executeLinuxServicePlan(plan, runner)).rejects.toThrow('boom')
    expect(seen.some((value) => value.includes('disable --now'))).toBe(true)
  })

  it('persists organization enrollment routing and workspace identity without the invite', () => {
    const rendered = renderLinuxServiceFiles({
      ...session, workspaceId: 'workspace_enrolled', routeHint: 'invitation-route',
      installationSource: 'private-cloud-invite',
    }, '/home/example')
    expect(JSON.parse(rendered.config)).toMatchObject({
      workspaceId: 'workspace_enrolled', routeHint: 'invitation-route', installationSource: 'private-cloud-invite',
    })
    expect(rendered.unit).not.toContain('secret-value')
    expect(rendered.config).not.toContain('secret-value')
  })

  it('enables no-new-privileges only in Restricted Mode', () => {
    const rendered = renderLinuxServiceFiles({ ...session, privilegeMode: 'restricted' }, '/home/example')
    expect(rendered.unit).toContain('NoNewPrivileges=yes')
    expect(JSON.parse(rendered.config).privilegeMode).toBe('restricted')
  })

  it('exposes status, logs, start, stop, restart, and uninstall service controls', () => {
    expect(createLinuxServicePlan('status', 'user', '/home/example').commands[0]).toMatchObject({ file: 'systemctl', args: ['--user', 'status', 'kala-executor.service'] })
    expect(createLinuxServicePlan('logs', 'user', '/home/example').commands[0]).toMatchObject({ file: 'journalctl', args: ['--user', '--unit', 'kala-executor.service', '--follow'] })
    expect(createLinuxServicePlan('start', 'system', '/home/example').commands[0]).toMatchObject({ file: 'systemctl', args: ['start', 'kala-executor.service'] })
    expect(createLinuxServicePlan('stop', 'system', '/home/example').commands[0]).toMatchObject({ file: 'systemctl', args: ['stop', 'kala-executor.service'] })
    expect(createLinuxServicePlan('restart', 'system', '/home/example').commands[0]).toMatchObject({ file: 'systemctl', args: ['restart', 'kala-executor.service'] })
    expect(createLinuxServicePlan('uninstall', 'system', '/home/example').commands.some((command) => command.args.includes('disable'))).toBe(true)
  })

  it('installs a separate persistent updater timer for managed generations', () => {
    const managed: InstallerSession = {
      ...session,
      managedRoot: '/var/lib/kala/executor',
      update: {
        manifestUrl: 'https://agent.example.test/install/assets/executor-update-manifest.json',
        publicKeyFile: '/var/lib/kala/executor/update-public-key.pem',
        channel: 'stable',
        intervalMinutes: 60,
      },
    }
    const rendered = renderLinuxServiceFiles(managed, '/home/example')
    expect(rendered.unit).toContain('/current/kala-executor')
    expect(rendered.updateUnit).toContain('update apply --config')
    expect(rendered.updateTimer).toContain('Persistent=true')
    const plan = createLinuxServicePlan('install', 'system', '/home/example', managed)
    expect(plan.commands.some((command) => command.args.includes('kala-executor-update.timer'))).toBe(true)
  })

  it('restarts an existing managed service so a repeated install activates the new generation', () => {
    const plan = createLinuxServicePlan('install', 'system', '/home/example', session)
    const serviceCommands = plan.commands
      .filter((command) => command.file === 'systemctl')
      .map((command) => command.args.join(' '))
    expect(serviceCommands).toContain('enable kala-executor.service')
    expect(serviceCommands).toContain('restart kala-executor.service')
    expect(serviceCommands).not.toContain('enable --now kala-executor.service')
    expect(serviceCommands.indexOf('enable kala-executor.service')).toBeLessThan(serviceCommands.indexOf('restart kala-executor.service'))
  })
})

function spawnCommand(command: { file: string; args: readonly string[]; stdin?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, [...command.args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }))
    child.stdin.end(command.stdin)
  })
}

describe('macOS service adapter', () => {
  it('renders safe system and user launchd definitions and rolls back writes', async () => {
    const system = createMacosLaunchdService({ scope: 'system', architecture: 'arm64', configPath: '/Library/Application Support/Kala/配置.json', executablePath: '/opt/homebrew/bin/kala-executor' })
    expect(system.plist).toContain('/opt/homebrew/bin/kala-executor')
    expect(system.plist).toContain('配置.json')
    expect(system.plist).not.toContain('token')

    const user = createMacosLaunchdService({ scope: 'user', architecture: 'x64', uid: 501, homeDirectory: '/Users/Test User', configPath: '/Users/Test User/Library/Application Support/Kala/config.json' })
    expect(user.domain).toBe('gui/501')
    const operations: string[] = []
    await expect(executeLaunchdPlan(user.plans.install, async (operation) => {
      operations.push(operation.kind === 'command' ? operation.args[0] ?? operation.executable : operation.kind)
      if (operation.kind === 'command' && operation.args[0] === 'bootstrap') throw new Error('bootstrap failed')
      return undefined
    })).rejects.toThrow('bootstrap failed')
    expect(operations).toContain('remove-file')
  })
})

describe('Windows service adapter', () => {
  it('quotes paths, excludes credentials, and executes only through the injected boundary', async () => {
    const plan = createWindowsServicePlan({ serviceName: 'KalaExecutor', programFiles: 'C:\\Program Files', programData: 'C:\\Program Data', executableName: 'kala-executor.exe' })
    const create = plan.commands.find((command) => command.action === 'create')!
    expect(create.args.join(' ')).toContain('C:\\Program Files')
    expect(create.args[3]).toBe('"C:\\Program Files\\Kala\\Executor\\kala-executor-service.exe"')
    expect(create.args.join(' ')).not.toMatch(/token|credential|--config/i)
    expect(plan.layout.serviceConfigPath).toBe('C:\\Program Files\\Kala\\Executor\\kala-executor-service.xml')
    expect(renderWindowsServiceConfig(plan.layout, 'KalaExecutor', 'Kala Executor')).toContain('<executable>%BASE%\\kala-executor.exe</executable>')
    expect(renderWindowsServiceConfig(plan.layout, 'KalaExecutor', 'Kala Executor')).toContain('--config &quot;C:\\Program Data\\Kala\\Executor\\config.json&quot;')
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }))
    await executeWindowsServicePlan(plan, ['create', 'recovery', 'start'], { platform: 'win32', runner })
    expect(runner).toHaveBeenCalledTimes(3)
  })

  it('copies the exact native, worker, and shared runtime files for service startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'runlab-windows-runtime-copy-'))
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    try {
      for (const relative of WINDOWS_NODE_PTY_RUNTIME_FILES) {
        const path = join(source, ...relative.split('/'))
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, relative)
      }
      copyWindowsNodePtyRuntime(source, destination)
      for (const relative of WINDOWS_NODE_PTY_RUNTIME_FILES) {
        expect(readFileSync(join(destination, ...relative.split('/')), 'utf8')).toBe(relative)
      }
      rmSync(join(source, 'worker', 'conoutSocketWorker.js'))
      const incomplete = join(root, 'incomplete')
      expect(() => copyWindowsNodePtyRuntime(source, incomplete)).toThrow('missing worker/conoutSocketWorker.js')
      expect(existsSync(incomplete)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('escapes service XML and rejects an untrusted binary before copying it', () => {
    const plan = createWindowsServicePlan({ serviceName: 'KalaExecutor', programData: 'C:\\Company & Friends\\Data' })
    const definition = renderWindowsServiceConfig(plan.layout, 'Kala <Executor>', 'R&D "Service"')
    expect(definition).toContain('Kala &lt;Executor&gt;')
    expect(definition).toContain('R&amp;D &quot;Service&quot;')
    expect(definition).toContain('C:\\Company &amp; Friends\\Data')
    expect(definition).not.toContain('token')
    const root = mkdtempSync(join(tmpdir(), 'runlab-windows-host-copy-'))
    try {
      expect(() => copyWindowsServiceHost(root, root)).toThrow(/missing or has the wrong size/)
      writeFileSync(join(root, 'kala-executor-service-host-win32-x64.exe'), 'untrusted')
      expect(() => copyWindowsServiceHost(root, root)).toThrow(/missing or has the wrong size/)
      expect(existsSync(join(root, 'kala-executor-service.exe'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds a protected SYSTEM self-removal task with no privileged temporary script', () => {
    const removal = createWindowsSelfRemovalPlan({
      installDir: "C:\\Program Files\\Kala & Co\\Executor's",
      dataDir: "C:\\ProgramData\\Kala & Co\\Executor's",
      statusDir: 'C:\\Windows\\Temp',
      ownerPid: 4242,
      id: '0123456789abcdef',
    })
    expect(removal.taskName).toBe('KalaExecutor-Uninstall-0123456789abcdef')
    expect(removal.taskXmlPath).toBe("C:\\ProgramData\\Kala & Co\\Executor's\\.uninstall-0123456789abcdef.xml")
    expect(removal.statusPath).toBe('C:\\Windows\\Temp\\kala-executor-uninstall-0123456789abcdef.status')
    expect(removal.taskXml).toContain('<?xml version="1.0" encoding="UTF-16"?>')
    const xmlBytes = encodeWindowsTaskXml(removal.taskXml)
    expect(xmlBytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]))
    expect(xmlBytes.subarray(2).toString('utf16le')).toBe(removal.taskXml)
    expect(removal.taskXml).toContain('<UserId>S-1-5-18</UserId>')
    expect(removal.taskXml).not.toContain('<LogonType>ServiceAccount</LogonType>')
    expect(removal.taskXml).not.toContain('.ps1')
    expect(removal.taskXml).not.toContain('Program Files')
    const encoded = removal.taskXml.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/u)?.[1]
    expect(encoded).toBeTruthy()
    const script = Buffer.from(encoded!, 'base64').toString('utf16le')
    expect(script).toContain("Remove-Tree 'C:\\Program Files\\Kala & Co\\Executor''s'")
    expect(script).toContain("Remove-Tree 'C:\\ProgramData\\Kala & Co\\Executor''s'")
    expect(script).toContain("Set-Status 'started'")
    expect(script).toContain('schtasks.exe" /Delete /TN')
    expect(script).toContain("throw 'path_remaining'")
    expect(script.indexOf("Set-Status 'started'")).toBeLessThan(script.indexOf('schtasks.exe" /Delete'))
    expect(() => createWindowsSelfRemovalPlan({ installDir: 'relative', dataDir: 'C:\\ProgramData\\Kala', statusDir: 'C:\\Temp', ownerPid: 1 })).toThrow('installation path')
    expect(() => createWindowsSelfRemovalPlan({ installDir: 'C:\\', dataDir: 'D:\\Kala', statusDir: 'C:\\Temp', ownerPid: 1 })).toThrow('Unsafe Windows self-removal installation path')
    expect(() => createWindowsSelfRemovalPlan({ installDir: 'C:\\Kala', dataDir: 'C:\\Kala\\Data', statusDir: 'C:\\Temp', ownerPid: 1 })).toThrow('must be separate')
    expect(() => createWindowsSelfRemovalPlan({ installDir: 'C:\\Program Files\\Kala', dataDir: 'C:\\ProgramData\\Kala', statusDir: 'C:\\ProgramData\\Kala\\status', ownerPid: 1 })).toThrow('status path')
  })

  it('registers and starts self-removal through Task Scheduler and cleans up a failed start', async () => {
    const removal = createWindowsSelfRemovalPlan({
      installDir: 'C:\\Program Files\\Kala\\Executor', dataDir: 'C:\\ProgramData\\Kala\\Executor',
      statusDir: 'C:\\Windows\\Temp', ownerPid: 4242, id: '0123456789abcdef',
    })
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }))
    await registerWindowsSelfRemovalTask(removal, { platform: 'win32', runner })
    expect(runner).toHaveBeenNthCalledWith(1, 'schtasks.exe', ['/Create', '/XML', removal.taskXmlPath, '/TN', removal.taskName])
    expect(runner).toHaveBeenNthCalledWith(2, 'schtasks.exe', ['/Run', '/TN', removal.taskName])

    const failingRunner = vi.fn(async (_command: string, args: readonly string[]) => ({
      exitCode: args[0] === '/Run' ? 1 : 0, stdout: '', stderr: args[0] === '/Run' ? 'run failed' : '',
    }))
    await expect(registerWindowsSelfRemovalTask(removal, { platform: 'win32', runner: failingRunner })).rejects.toThrow('Unable to start Windows removal task')
    expect(failingRunner).toHaveBeenNthCalledWith(3, 'schtasks.exe', ['/Delete', '/TN', removal.taskName, '/F'])
  })

  it('checks effective Windows Administrator membership before consuming a service invite', async () => {
    const runner = vi.fn(async (_file: string, _args: readonly string[]) => ({ exitCode: 0, stdout: '', stderr: '' }))
    const options = { platform: 'win32' as const, systemRoot: 'C:\\Windows', runner }
    await assertElevatedWindowsAdministrator(options)
    expect(runner).toHaveBeenCalledTimes(1)
    const [file, args] = runner.mock.calls[0]!
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args).toContain('-NoProfile')
    expect(args.join(' ')).toContain('WindowsPrincipal')
    expect(args.join(' ')).toContain('IsInRole')
    await expect(assertElevatedWindowsAdministrator({ ...options, runner: async () => ({ exitCode: 1, stdout: '', stderr: '' }) })).rejects.toThrow('requires an elevated Administrator process')
    await expect(assertElevatedWindowsAdministrator({ ...options, runner: async () => { throw new Error('PowerShell unavailable') } })).rejects.toThrow('requires an elevated Administrator process')
    await expect(assertElevatedWindowsAdministrator({ ...options, systemRoot: 'relative' })).rejects.toThrow('requires an elevated Administrator process')
    await expect(assertElevatedWindowsAdministrator({ ...options, platform: 'linux' })).rejects.toThrow('requires an elevated Administrator process')
  })

  it('restricts Windows service credentials to LocalSystem and Administrators before use', async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: 'Successfully processed 1 files', stderr: '' }))
    await secureWindowsServiceDataDir('C:\\ProgramData\\Kala\\Executor', { platform: 'win32', runner })
    expect(runner).toHaveBeenCalledWith('icacls.exe', [
      'C:\\ProgramData\\Kala\\Executor', '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F',
    ])
    await expect(secureWindowsServiceDataDir('C:\\ProgramData\\Kala\\Executor', {
      platform: 'win32', runner: async () => ({ exitCode: 5, stdout: '', stderr: 'Access denied' }),
    })).rejects.toThrow('Unable to secure Windows Executor credentials directory')
  })

  it('waits for STOPPED, tolerates only missing services, and rejects unknown SCM status', async () => {
    const plan = createWindowsServicePlan({ serviceName: 'KalaExecutor' })
    const states = ['STATE : 3 STOP_PENDING', 'STATE : 1 STOPPED']
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: states.shift() ?? 'STATE : 1 STOPPED', stderr: '' }))
    await waitForWindowsServiceStopped(plan, { platform: 'win32', runner, pollMs: 1 })
    expect(runner).toHaveBeenCalledTimes(2)
    await expect(waitForWindowsServiceStopped(plan, {
      platform: 'win32', runner: async () => ({ exitCode: 1060, stdout: '[SC] OpenService FAILED 1060:', stderr: '' }),
    })).resolves.toBeUndefined()
    await expect(waitForWindowsServiceStopped(plan, {
      platform: 'win32', runner: async () => ({ exitCode: 5, stdout: 'Access denied', stderr: '' }),
    })).rejects.toThrow('SCM query failed')
    await expect(waitForWindowsServiceStopped(plan, {
      platform: 'win32', runner: async () => ({ exitCode: 0, stdout: 'unknown', stderr: '' }),
    })).rejects.toThrow('unrecognized state')
  })

  it('binds uninstall to a recognized installation identity', () => {
    expect(assertManagedWindowsInstallation({ installationSource: 'dashboard-native', installationId: 'install-1' }).installationId).toBe('install-1')
    expect(assertManagedWindowsInstallation({ installationSource: 'private-cloud-invite', installationId: 'invite-route' }).installationSource).toBe('private-cloud-invite')
    expect(() => assertManagedWindowsInstallation({ installationSource: 'manual', installationId: 'install-1' })).toThrow('Refusing')
    expect(() => assertManagedWindowsInstallation({ installationSource: 'dashboard-native', installationId: '' })).toThrow('Refusing')
  })
})
