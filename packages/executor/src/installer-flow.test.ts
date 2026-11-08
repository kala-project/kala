import { generateKeyPairSync, sign } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { assertNoExistingPosixService, assertSupportedInstallerPrivileges, bootstrapEnvironment, downloadExecutorUpdateAssets, pinExecutorUpdateKey, reportInstallation, waitForApproval, writeInstallerSession } from './installer-flow.js'
import { readExecutorRuntimeConfig } from './executor-config.js'
import { readInstallerSession } from './installer-session.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('installer flow', () => {
  it('explains an existing user or system service without modifying its configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'executor-service-conflict-')); roots.push(root)
    const config = join(root, 'config.json')
    const managedRoot = join(root, 'managed')
    expect(() => assertNoExistingPosixService(config, managedRoot, 'user', 'linux')).not.toThrow()
    writeFileSync(config, '{}', { mode: 0o600 })
    expect(() => assertNoExistingPosixService(config, managedRoot, 'user', 'linux'))
      .toThrow(/systemctl --user status kala-executor\.service[\s\S]*service uninstall --user[\s\S]*workspace identity are preserved/u)
    expect(() => assertNoExistingPosixService(config, managedRoot, 'system', 'linux'))
      .toThrow(/systemctl status kala-executor\.service[\s\S]*service uninstall --system/u)
    expect(() => assertNoExistingPosixService(config, managedRoot, 'user', 'darwin'))
      .toThrow(/macOS uninstall stops the launchd job[\s\S]*retains its configuration/u)
    expect(readFileSync(config, 'utf8')).toBe('{}')
  })

  it.skipIf(process.getuid?.() === 0)('rejects invite enrollment before network access when the user service already exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'executor-invite-conflict-')); roots.push(root)
    const configDir = join(root, '.config/kala/executor')
    mkdirSync(configDir, { recursive: true })
    const config = join(configDir, 'config.json')
    writeFileSync(config, '{}', { mode: 0o600 })
    const child = spawnSync(process.execPath, ['--import', 'tsx', new URL('../bin/kala-executor.ts', import.meta.url).pathname, '--invite-installer'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env, HOME: root, HOST_URL: 'http://127.0.0.1:1', EXECUTOR_INVITE: 'ak_invite_test',
        KALA_INVITE_INSTALL_MODE: 'service', KALA_INVITE_PRIVILEGE_MODE: 'privileged',
      },
    })
    expect(child.status, child.stderr).toBe(1)
    expect(child.stderr).toContain('systemctl --user status kala-executor.service')
    expect(child.stderr).toContain('service uninstall --user')
    expect(child.stdout).not.toContain('Starting organization-bound invite enrollment')
    const setup = spawnSync(process.execPath, ['--import', 'tsx', new URL('../bin/kala-executor.ts', import.meta.url).pathname, '--internal-installer'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env, HOME: root, HOST_URL: 'http://127.0.0.1:1',
        EXECUTOR_INSTALL_ID: 'fixture', EXECUTOR_INSTALL_BOOTSTRAP: 'fixture',
        EXECUTOR_INSTALL_MODE: 'service', EXECUTOR_INSTALL_ROOT: root, EXECUTOR_PRIVILEGE_MODE: 'privileged',
      },
    })
    expect(setup.status, setup.stderr).toBe(1)
    expect(setup.stderr).toContain('service uninstall --user')
    expect(setup.stdout).not.toContain('pairing')
    expect(readFileSync(config, 'utf8')).toBe('{}')
  })

  it('checks Windows service elevation before progress, pairing, identity creation, or token redemption', () => {
    const cli = readFileSync(new URL('../bin/kala-executor.ts', import.meta.url), 'utf8')
    const flow = cli.slice(cli.indexOf('async function runInternalInstaller()'), cli.indexOf('async function runInviteInstaller()'))
    expect(flow).toContain("if (env.EXECUTOR_INSTALL_MODE === 'service' && process.platform === 'win32')")
    const check = flow.indexOf('await assertElevatedWindowsAdministrator()')
    expect(check).toBeGreaterThan(0)
    for (const operation of ['await reportInstallation(', 'await waitForApproval(', 'loadOrCreateWorkspaceId()', 'await redeemInstallation(']) {
      expect(flow.indexOf(operation)).toBeGreaterThan(check)
    }
  })

  it('requires a signed Linux update feed before pairing or invite enrollment', () => {
    const cli = readFileSync(new URL('../bin/kala-executor.ts', import.meta.url), 'utf8')
    const installer = cli.slice(cli.indexOf('async function runInternalInstaller()'), cli.indexOf('async function runInviteInstaller()'))
    expect(installer.indexOf('await downloadExecutorUpdateAssets(env.HOST_URL)'))
      .toBeLessThan(installer.indexOf("await reportInstallation(env, 'pairing_pending')"))
    const invite = cli.slice(cli.indexOf('async function runInviteInstaller()'), cli.indexOf('function posixServiceOptions()'))
    expect(invite.indexOf('await downloadExecutorUpdateAssets(host)'))
      .toBeLessThan(invite.indexOf('startExecutor({ host, workspaceId'))
  })

  it('installs the verified CJS rather than copying Node.exe and defers removal when running the installed script', () => {
    const cli = readFileSync(new URL('../bin/kala-executor.ts', import.meta.url), 'utf8')
    const install = cli.slice(cli.indexOf('async function installWindowsService('), cli.indexOf('function writePrivateAtomic('))
    expect(install).toContain('windowsExecutorSourceRoot(process.execPath, process.argv[1], process.versions.node)')
    expect(install).toContain('nodeExecutablePath: process.execPath')
    expect(install).toContain('await secureWindowsServiceInstallDir(plan.layout.installDir)')
    expect(install).toContain('copyWindowsExecutorCjs(sourceRoot, plan.layout.executablePath, process.env.KALA_VERIFIED_EXECUTOR_SHA256')
    expect(install).toContain('copyWindowsNodePtyRuntime(sourceRoot, plan.layout.installDir, process.env.KALA_VERIFIED_CONPTY_MANIFEST_SHA256')
    expect(install).toContain('copyWindowsServiceHost(sourceRoot, plan.layout.installDir)')
    expect(install).not.toContain('copyFileSync(process.execPath')
    const uninstall = cli.slice(cli.indexOf('async function manageWindowsService('), cli.indexOf('async function scheduleWindowsSelfRemoval('))
    expect(uninstall).toContain('resolve(process.argv[1] ?? \'\')')
    expect(uninstall).toContain('scheduleWindowsSelfRemoval(plan.layout.installDir, plan.layout.dataDir)')
  })

  it('validates environment and writes private sessions atomically', () => {
    const env = bootstrapEnvironment({ HOST_URL: 'https://host', EXECUTOR_INSTALL_ID: 'inst', EXECUTOR_INSTALL_BOOTSTRAP: 'boot', EXECUTOR_INSTALL_MODE: 'service', EXECUTOR_INSTALL_ROOT: '/repo', EXECUTOR_PRIVILEGE_MODE: 'privileged' })
    expect(env.EXECUTOR_INSTALL_MODE).toBe('service')
    expect(env.EXECUTOR_PRIVILEGE_MODE).toBe('privileged')
    const root = mkdtempSync(join(tmpdir(), 'installer-flow-')); roots.push(root)
    const path = join(root, 'private', 'session.json')
    writeInstallerSession(path, { version: 1, mode: 'user', privilegeMode: 'privileged', executable: '/bin/kala-executor', host: 'https://host', sandboxRoots: ['/repo'], credential: { token: 'ak_exec_test' } })
    expect(JSON.parse(readFileSync(path, 'utf8')).host).toBe('https://host')
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('accepts both privilege modes and rejects unknown values', () => {
    expect(bootstrapEnvironment({
      HOST_URL: 'https://host', EXECUTOR_INSTALL_ID: 'inst', EXECUTOR_INSTALL_BOOTSTRAP: 'boot',
      EXECUTOR_INSTALL_MODE: 'service', EXECUTOR_INSTALL_ROOT: '/repo', EXECUTOR_PRIVILEGE_MODE: 'restricted',
    }).EXECUTOR_PRIVILEGE_MODE).toBe('restricted')
    expect(() => bootstrapEnvironment({
      HOST_URL: 'https://host', EXECUTOR_INSTALL_ID: 'inst', EXECUTOR_INSTALL_BOOTSTRAP: 'boot',
      EXECUTOR_INSTALL_MODE: 'service', EXECUTOR_INSTALL_ROOT: '/repo', EXECUTOR_PRIVILEGE_MODE: 'root',
    })).toThrow('Invalid EXECUTOR_PRIVILEGE_MODE')
  })

  it('rejects restricted root system services before pairing but permits user services and explicit privileged root services', () => {
    const restricted = bootstrapEnvironment({
      HOST_URL: 'https://host', EXECUTOR_INSTALL_ID: 'inst', EXECUTOR_INSTALL_BOOTSTRAP: 'boot',
      EXECUTOR_INSTALL_MODE: 'service', EXECUTOR_INSTALL_ROOT: '/repo', EXECUTOR_PRIVILEGE_MODE: 'restricted',
    })
    expect(() => assertSupportedInstallerPrivileges(restricted, true)).toThrow('cannot run as a root system service')
    expect(() => assertSupportedInstallerPrivileges(restricted, false)).not.toThrow()
    expect(() => assertSupportedInstallerPrivileges({ ...restricted, EXECUTOR_PRIVILEGE_MODE: 'privileged' }, true)).not.toThrow()
    expect(() => assertSupportedInstallerPrivileges({ ...restricted, EXECUTOR_INSTALL_MODE: 'temporary' }, true)).not.toThrow()
  })

  it('migrates legacy installer sessions and runtime configs without changing existing rights', () => {
    const root = mkdtempSync(join(tmpdir(), 'installer-privilege-mode-')); roots.push(root)
    const sessionPath = join(root, 'session.json')
    writeFileSync(sessionPath, JSON.stringify({
      version: 1, mode: 'user', executable: '/bin/kala-executor', host: 'https://host',
      sandboxRoots: ['/repo'], credential: { token: 'ak_exec_test' },
    }), { mode: 0o600 })
    expect(readInstallerSession(sessionPath).privilegeMode).toBe('restricted')
    writeFileSync(sessionPath, JSON.stringify({
      version: 1, mode: 'system', executable: '/bin/kala-executor', host: 'https://host',
      sandboxRoots: ['/repo'], credential: { token: 'ak_exec_test' },
    }), { mode: 0o600 })
    expect(readInstallerSession(sessionPath).privilegeMode).toBe('privileged')

    const configPath = join(root, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      version: 1, host: 'https://host', sandboxRoots: ['/repo'], credentialFile: '/credential',
    }), { mode: 0o600 })
    expect(readExecutorRuntimeConfig(configPath).privilegeMode).toBe('restricted')
    writeFileSync(configPath, JSON.stringify({
      version: 1, host: 'https://host', sandboxRoots: ['/repo'], credentialFile: '/credential', serviceMode: 'system',
    }), { mode: 0o600 })
    expect(readExecutorRuntimeConfig(configPath).privilegeMode).toBe('privileged')
    writeFileSync(configPath, JSON.stringify({
      version: 1, host: 'https://host', sandboxRoots: ['/repo'], credentialFile: '/credential',
      installationSource: 'dashboard-native', workspaceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    }), { mode: 0o600 })
    expect(readExecutorRuntimeConfig(configPath).workspaceId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    writeFileSync(configPath, JSON.stringify({
      version: 1, host: 'https://host', sandboxRoots: ['/repo'], credentialFile: '/credential', workspaceId: '../different-user',
    }), { mode: 0o600 })
    expect(() => readExecutorRuntimeConfig(configPath)).toThrow('Invalid Executor config')
    writeFileSync(configPath, JSON.stringify({
      version: 1, host: 'https://host', sandboxRoots: ['/repo'], credentialFile: '/credential', privilegeMode: 'root',
    }))
    expect(() => readExecutorRuntimeConfig(configPath)).toThrow('Invalid Executor privilege mode')
  })

  it('refuses service installs when signed update assets are missing or incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })))
    await expect(downloadExecutorUpdateAssets('https://host/'))
      .rejects.toThrow('failed to download Executor update manifest: 404')

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('.json')
        ? new Response('{}', { status: 200 })
        : new Response('missing', { status: 404 })
    )))
    await expect(downloadExecutorUpdateAssets('https://host'))
      .rejects.toThrow('failed to download Executor update verification key: 404')
  })

  it('checks the signed update feed before pinning its verification key', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const signed = JSON.stringify({ version: 1, release: '0.3.1', channel: 'stable',
      protocol: { min: 1, max: 1 },
      artifact: { url: './kala-executor.cjs', file: 'kala-executor', size: 3, sha256: 'a'.repeat(64) } })
    const signature = sign(null, Buffer.from(signed), privateKey).toString('base64')
    let response = JSON.stringify({ signed, signature })
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('.pem')
        ? new Response(pem, { status: 200 })
        : new Response(response, { status: 200 })
    )))
    await expect(downloadExecutorUpdateAssets('https://host/')).resolves.toEqual({
      manifestUrl: 'https://host/install/assets/executor-update-manifest.json',
      publicKey: pem,
    })
    response = JSON.stringify({ signed: `${signed} `, signature })
    await expect(downloadExecutorUpdateAssets('https://host/'))
      .rejects.toThrow('signature verification failed')
    await expect(downloadExecutorUpdateAssets('http://host.example.test/'))
      .rejects.toThrow('require HTTPS or a loopback Host')
    const root = mkdtempSync(join(tmpdir(), 'executor-update-key-')); roots.push(root)
    pinExecutorUpdateKey(root, pem)
    expect(statSync(join(root, 'update-public-key.pem')).mode & 0o777).toBe(0o600)
    expect(() => pinExecutorUpdateKey(root, pem)).not.toThrow()
    expect(() => pinExecutorUpdateKey(root, pem.replace('PUBLIC KEY', 'OTHER KEY')))
      .toThrow('differs or is unsafe')
    rmSync(join(root, 'update-public-key.pem'))
    symlinkSync(join(root, 'missing-key'), join(root, 'update-public-key.pem'))
    expect(() => pinExecutorUpdateKey(root, pem)).toThrow('differs or is unsafe')
  })

  it('reports status without exposing bootstrap in body and waits for approval', async () => {
    const env = bootstrapEnvironment({ HOST_URL: 'https://host', EXECUTOR_INSTALL_ID: 'inst', EXECUTOR_INSTALL_BOOTSTRAP: 'boot', EXECUTOR_INSTALL_MODE: 'temporary', EXECUTOR_INSTALL_ROOT: '/repo', EXECUTOR_PRIVILEGE_MODE: 'privileged' })
    let reads = 0
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ status: 'asset_verified' }), { status: 200 })
      reads += 1
      return new Response(JSON.stringify({ status: reads > 1 ? 'paired' : 'pairing_pending' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await reportInstallation(env, 'asset_verified')
    await waitForApproval(env, 1)
    const postBody = String(fetchMock.mock.calls[0]?.[1]?.body)
    expect(postBody).not.toContain('boot')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer boot' })
  })
})
