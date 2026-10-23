import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { assertSupportedInstallerPrivileges, bootstrapEnvironment, downloadExecutorUpdateAssets, reportInstallation, waitForApproval, writeInstallerSession } from './installer-flow.js'
import { readExecutorRuntimeConfig } from './executor-config.js'
import { readInstallerSession } from './installer-session.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('installer flow', () => {
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

  it('allows deployments without managed update assets and rejects partial publication', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })))
    await expect(downloadExecutorUpdateAssets('https://host/')).resolves.toBeUndefined()

    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('.json')
        ? new Response('{}', { status: 200 })
        : new Response('missing', { status: 404 })
    )))
    await expect(downloadExecutorUpdateAssets('https://host'))
      .rejects.toThrow('failed to download Executor update verification key: 404')
  })

  it('downloads the complete managed update metadata pair', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('.pem')
        ? new Response('PUBLIC KEY', { status: 200 })
        : new Response('{}', { status: 200 })
    )))
    await expect(downloadExecutorUpdateAssets('https://host/')).resolves.toEqual({
      manifestUrl: 'https://host/install/assets/executor-update-manifest.json',
      publicKey: 'PUBLIC KEY',
    })
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
