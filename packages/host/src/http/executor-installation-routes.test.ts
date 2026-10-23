import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { attachExecutorInstallationRoutes } from './executor-installation-routes.js'
import { ExecutorInstallationStore } from '../store/executor-installation.js'
import { ExecutorIdentityStore } from '../store/executor-identity.js'

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const hasPowerShell = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' }).status === 0

describe('executor installation routes', () => {
  const servers: ReturnType<typeof createServer>[] = []
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))) })

  async function start(tenancy: 'single-tenant' | 'multi-tenant' = 'single-tenant', windowsReleaseAssetsReady = false) {
    const dir = mkdtempSync(join(tmpdir(), 'executor-install-api-'))
    const store = new ExecutorInstallationStore(join(dir, 'installs.json'))
    const identities = new ExecutorIdentityStore(join(dir, 'identities.json'))
    const server = createServer(); servers.push(server)
    attachExecutorInstallationRoutes(server, { store, identities, tenancy, windowsReleaseAssetsReady: () => windowsReleaseAssetsReady })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address')
    return { url: `http://localhost:${address.port}`, dir, store, identities }
  }

  it('does not emit permissive CORS headers without a validated public access gate', async () => {
    const { url } = await start()
    const response = await fetch(`${url}/api/executor-installs`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:5302',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
    expect(response.headers.get('access-control-allow-headers')).toContain('content-type')

    const capabilities = await fetch(`${url}/api/executor-install-capabilities`, {
      headers: { origin: 'https://untrusted.example.test' },
    })
    expect(capabilities.status).toBe(200)
    expect(capabilities.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('reports authenticated, side-effect-free platform readiness from the Host asset check', async () => {
    const unavailable = await start('single-tenant', false)
    const createSpy = vi.spyOn(unavailable.store, 'create')
    const unavailableResponse = await fetch(`${unavailable.url}/api/executor-install-capabilities`)
    expect(unavailableResponse.status).toBe(200)
    await expect(unavailableResponse.json()).resolves.toEqual({
      platforms: {
        linux: { available: true },
        macos: { available: true },
        windows: { available: false },
      },
    })
    expect(createSpy).not.toHaveBeenCalled()

    const available = await start('single-tenant', true)
    await expect(fetch(`${available.url}/api/executor-install-capabilities`).then((response) => response.json())).resolves.toEqual({
      platforms: {
        linux: { available: true },
        macos: { available: true },
        windows: { available: true },
      },
    })
  })

  it('supports Linux and macOS installs but rejects Windows when trusted release assets are unavailable', async () => {
    const { url, dir } = await start()
    for (const platform of ['linux', 'macos']) {
      const response = await fetch(`${url}/api/executor-installs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform, mode: 'service', privilegeMode: 'privileged', workspaceRoot: '/work/example', label: `${platform}-fixture` }),
      })
      expect(response.status).toBe(201)
      const created = await response.json() as { command: string; setupCode: string }
      expect(created.command).toContain(`${url}/install`)
      expect(created.command).not.toContain('install.ps1')
      expect(readFileSync(join(dir, 'installs.json'), 'utf8')).not.toContain(created.setupCode)
    }
    for (const mode of ['temporary', 'service']) {
      const response = await fetch(`${url}/api/executor-installs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'windows', mode, privilegeMode: 'privileged', workspaceRoot: 'C:\\work\\example', label: 'windows-fixture' }),
      })
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({ error: 'windows_release_assets_unavailable' })
    }
    const installer = await fetch(`${url}/install.ps1`)
    expect(installer.status).toBe(410)
    expect(await installer.json()).toEqual({ error: 'windows_release_assets_unavailable' })
    expect((await fetch(`${url}/install/invite.ps1`)).status).toBe(410)
  })

  it('creates Windows sessions and serves a native-only PowerShell bootstrap when trusted assets are ready', async () => {
    const { url } = await start('single-tenant', true)
    for (const mode of ['temporary', 'service']) {
      const response = await fetch(`${url}/api/executor-installs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'windows', mode, privilegeMode: 'privileged', workspaceRoot: 'C:\\work\\example' }),
      })
      expect(response.status).toBe(201)
      const created = await response.json() as { command: string; setupCode: string }
      expect(created.command).toContain(`${url}/install.ps1`)
      expect(created.command).toContain(`KALA_INSTALL_MODE='${mode}'`)
    }
    const installer = await fetch(`${url}/install.ps1`)
    expect(installer.status).toBe(200)
    const script = await installer.text()
    expect(script).toContain('/install/assets/install-executor.ps1')
    expect(script.indexOf('/install/assets/install-executor.ps1')).toBeLessThan(script.indexOf('/install/session'))
    expect(script).toContain('& $installer --internal-installer')
    const preflight = script.indexOf('Assert-KalaInstallPrivileges $env:KALA_INSTALL_MODE')
    expect(preflight).toBeGreaterThan(0)
    expect(preflight).toBeLessThan(script.indexOf('Invoke-WebRequest'))
    expect(preflight).toBeLessThan(script.indexOf('Invoke-RestMethod'))
    const authoritativePreflight = script.indexOf('Assert-KalaInstallPrivileges $claim.env.EXECUTOR_INSTALL_MODE')
    expect(authoritativePreflight).toBeGreaterThan(script.indexOf('Invoke-RestMethod'))
    expect(authoritativePreflight).toBeLessThan(script.indexOf('[Environment]::SetEnvironmentVariable'))
    expect(script).toContain('Run as administrator')
    expect(script).not.toMatch(/& \$installer\r?\n/u)
    expect(script).not.toMatch(/winget|KALA_INSTALL_NODE|kala-executor\.cjs/iu)

    const inviteInstaller = await fetch(`${url}/install/invite.ps1`)
    expect(inviteInstaller.status).toBe(200)
    const inviteScript = await inviteInstaller.text()
    expect(inviteScript).toContain(`$expectedHost = '${url}'`)
    expect(inviteScript).toContain(`$expectedAssets = '${url}/install/assets'`)
    expect(inviteScript).toContain('& $installer --invite-installer')
    expect(inviteScript).toContain('Windows service installation requires an elevated Administrator PowerShell')
    expect(inviteScript).not.toMatch(/[?&](?:invite|token)=/u)
    const head = await fetch(`${url}/install/invite.ps1`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const rejected = await fetch(`${url}/install/invite.ps1`, { method: 'POST' })
    expect(rejected.status).toBe(405)
    expect(rejected.headers.get('allow')).toBe('GET, HEAD')
    expect((await fetch(`${url}/install/invite.ps1?invite=forbidden`)).status).toBe(400)
  })

  it.skipIf(!hasPowerShell)('executes service elevation preflight without downloading assets or claiming a setup code', async () => {
    const { url } = await start('single-tenant', true)
    const script = await fetch(`${url}/install.ps1`).then((response) => response.text())
    for (const scenario of [
      { mode: 'service', administrator: false, blocked: true },
      { mode: 'SERVICE', administrator: false, blocked: true },
      { mode: 'service', administrator: true, blocked: false },
      { mode: 'temporary', administrator: false, blocked: false },
      { mode: '', administrator: false, blocked: false },
    ]) {
      const command = [
        "$ErrorActionPreference = 'Stop'",
        "$testPrincipal = [PSCustomObject]@{}",
        `$testPrincipal | Add-Member -MemberType ScriptMethod -Name IsInRole -Value { return $${scenario.administrator} }`,
        "function New-Object { param($TypeName, $ArgumentList); if ($TypeName -ne 'Security.Principal.WindowsPrincipal') { throw 'Unexpected type' }; return $testPrincipal }",
        // Replace only the Windows identity acquisition; execute the served bootstrap.
        "function Invoke-WebRequest { throw 'Reached installer download' }",
        "function Invoke-RestMethod { throw 'Unexpected setup code claim' }",
        script.replace('[Security.Principal.WindowsIdentity]::GetCurrent()', '$null'),
      ].join('\n')
      const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        env: { ...process.env, KALA_INSTALL_MODE: scenario.mode, KALA_SETUP_CODE: 'ABCDEF1234' },
      })
      expect(result.status, result.stderr).not.toBe(0)
      const output = `${result.stdout}\n${result.stderr}`
      expect(output).not.toContain('Unexpected setup code claim')
      if (scenario.blocked) {
        expect(output).toContain('requires an elevated Administrator PowerShell')
        expect(output).not.toContain('Reached installer download')
      } else {
        expect(output).toContain('Reached installer download')
      }
    }
  })

  it('rejects invalid input but never exposes server filesystem paths after a persistence fault', async () => {
    const { url, store } = await start()
    const invalid = await fetch(`${url}/api/executor-installs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'invalid' }) })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid_request' })
    vi.spyOn(store, 'create').mockImplementation(() => { throw new Error('private filesystem location should never leave the server') })
    const broken = await fetch(`${url}/api/executor-installs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'macos', mode: 'temporary', privilegeMode: 'privileged', workspaceRoot: '/work/example' }) })
    expect(broken.status).toBe(500)
    expect(await broken.json()).toEqual({ error: 'internal_error' })
  })

  it('creates, patches, reports progress, approves, redeems, and short-polls', async () => {
    const { url, dir, identities } = await start()
    const createdResponse = await fetch(`${url}/api/executor-installs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'linux', mode: 'temporary', privilegeMode: 'privileged', workspaceRoot: '/work' }) })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { id: string; command: string; setupCode: string }
    expect(created.command).toBe(`curl -fsSL '${url}/install' | KALA_SETUP_CODE='${created.setupCode}' KALA_INSTALL_MODE='temporary' sh`)
    expect(created.command).not.toMatch(/sudo|ak_install_|[?&](?:invite|token|session)=/u)
    expect(created.setupCode).toMatch(/^[A-F0-9]{10}$/u)
    expect(readFileSync(join(dir, 'installs.json'), 'utf8')).not.toContain(created.setupCode)

    expect((await fetch(`${url}/api/executor-installs/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'runner' }) })).status).toBe(200)
    const installer = await fetch(`${url}/install`)
    expect(installer.status).toBe(200)
    const installerScript = await installer.text()
    expect(installerScript).toContain('KALA_SETUP_CODE')
    expect(installerScript).toContain('/install/session')
    expect(installerScript).toContain('COMPONENT=executor bash "$installer" --internal-installer')
    expect(installerScript.indexOf('/install/assets/run.sh')).toBeLessThan(installerScript.indexOf('/install/session'))
    expect(installerScript).not.toContain('install-executor.sh')
    expect(installerScript).not.toContain('| sh')
    expect(installerScript).toContain('curl --fail --silent --show-error --location')
    expect(installerScript).toContain('[1/4] Downloading verified installer')
    expect(installerScript).toContain('[3/4] Installing Executor')
    expect(installerScript).not.toContain('curl -fSL')
    const claimed = await fetch(`${url}/install/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupCode: created.setupCode }) })
    expect(claimed.status).toBe(200)
    const claim = await claimed.json() as { env: { EXECUTOR_INSTALL_BOOTSTRAP: string; EXECUTOR_PRIVILEGE_MODE: string; KALA_RELEASE_BASE_URL: string; KALA_RELEASE_TRUST: string; KALA_RELEASE_ASSETS_URL: string; KALA_INSTALLER_ALLOW_UNSIGNED?: string } }
    const bootstrap = claim.env.EXECUTOR_INSTALL_BOOTSTRAP
    expect(bootstrap).toMatch(/^ak_install_/u)
    expect(claim.env.EXECUTOR_PRIVILEGE_MODE).toBe('privileged')
    expect(claim.env.KALA_RELEASE_BASE_URL).toBe(`${url}/install/assets`)
    expect(claim.env.KALA_RELEASE_TRUST).toBe('host')
    expect(claim.env.KALA_RELEASE_ASSETS_URL).toBe(`${url}/install/assets`)
    expect(claim.env.KALA_INSTALLER_ALLOW_UNSIGNED).toBeUndefined()
    expect((await fetch(`${url}/install/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupCode: created.setupCode }) })).status).toBe(401)
    for (const status of ['asset_verified', 'pairing_pending']) {
      expect((await fetch(`${url}/api/executor-installs/${created.id}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap, status }) })).status).toBe(200)
    }
    const redeemed = await fetch(`${url}/api/executor-installs/${created.id}/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap, workspaceId: 'ws-api' }) })
    const redeemedBody = await redeemed.json() as { token: string }
    expect(redeemedBody.token).toMatch(/^ak_exec_/)
    expect(identities.resolveToken(redeemedBody.token)).toMatchObject({ workspaceId: 'ws-api', installId: created.id })
    expect((await fetch(`${url}/api/executor-installs/${created.id}/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bootstrap, workspaceId: 'ws-api' }) })).status).toBe(409)
    const events = await fetch(`${url}/api/executor-installs/${created.id}/events?after=1`).then((response) => response.json()) as { events: Array<{ seq: number }> }
    expect(events.events.every((event) => event.seq > 1)).toBe(true)
  })

  it('ignores untrusted forwarded origin headers and uses the direct loopback origin', async () => {
    const { url } = await start()
    const created = await fetch(`${url}/api/executor-installs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'linux', mode: 'temporary', privilegeMode: 'privileged', workspaceRoot: '/work' }),
    }).then((response) => response.json()) as { setupCode: string }
    const insecureHeaders = { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'downloads.example.test' }
    const bootstrap = await fetch(`${url}/install`, { headers: insecureHeaders })
    expect(bootstrap.status).toBe(200)
    const claim = await fetch(`${url}/install/session`, {
      method: 'POST', headers: { ...insecureHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ setupCode: created.setupCode }),
    })
    expect(claim.status).toBe(200)
  })

  it('requires ingress admin for multi-tenant Platform while single-tenant no-auth remains explicitly usable', async () => {
    const dedicated = await start('single-tenant')
    expect((await fetch(`${dedicated.url}/api/executor-installs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'linux', mode: 'service', privilegeMode: 'privileged', workspaceRoot: '/work' }) })).status).toBe(201)
    const privateCloud = await start('multi-tenant')
    const capabilityPath = `${privateCloud.url}/api/executor-install-capabilities`
    const anonymousCapabilities = await fetch(capabilityPath)
    expect(anonymousCapabilities.status).toBe(403)
    await expect(anonymousCapabilities.json()).resolves.toEqual({ error: 'admin_required' })
    const memberHeaders = { 'x-agent-runlab-principal': 'p', 'x-agent-runlab-organization-id': 'o', 'x-agent-runlab-organization-role': 'member' }
    expect((await fetch(capabilityPath, { headers: memberHeaders })).status).toBe(403)
    const adminHeaders = { 'x-agent-runlab-principal': 'p', 'x-agent-runlab-organization-id': 'o', 'x-agent-runlab-organization-role': 'admin' }
    const adminCapabilities = await fetch(capabilityPath, { headers: adminHeaders })
    expect(adminCapabilities.status).toBe(200)
    await expect(adminCapabilities.json()).resolves.toMatchObject({ platforms: { windows: { available: false } } })

    const body = JSON.stringify({ platform: 'linux', mode: 'service', privilegeMode: 'privileged', workspaceRoot: '/work' })
    const anonymous = await fetch(`${privateCloud.url}/api/executor-installs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect(anonymous.status).toBe(403)
    await expect(anonymous.json()).resolves.toEqual({ error: 'admin_required' })
    const member = await fetch(`${privateCloud.url}/api/executor-installs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-runlab-principal': 'p', 'x-agent-runlab-organization-id': 'o', 'x-agent-runlab-organization-role': 'member' }, body })
    expect(member.status).toBe(403)
    await expect(member.json()).resolves.toEqual({ error: 'admin_required' })
    expect((await fetch(`${privateCloud.url}/api/executor-installs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-runlab-principal': 'p', 'x-agent-runlab-organization-id': 'o', 'x-agent-runlab-organization-role': 'admin' }, body })).status).toBe(201)
  })

  it('scopes multi-tenant executor install management to the creating Organization', async () => {
    const privateCloud = await start('multi-tenant')
    const orgAHeaders = {
      'content-type': 'application/json',
      'x-agent-runlab-principal': 'admin-a@example.test',
      'x-agent-runlab-organization-id': 'org_a',
      'x-agent-runlab-organization-role': 'admin',
    }
    const orgBHeaders = {
      'content-type': 'application/json',
      'x-agent-runlab-principal': 'admin-b@example.test',
      'x-agent-runlab-organization-id': 'org_b',
      'x-agent-runlab-organization-role': 'admin',
    }
    const created = await fetch(`${privateCloud.url}/api/executor-installs`, {
      method: 'POST',
      headers: orgAHeaders,
      body: JSON.stringify({ platform: 'linux', mode: 'service', privilegeMode: 'privileged', workspaceRoot: '/work' }),
    }).then((response) => response.json()) as { id: string; organizationId: string; principal: string; organizationRole: string }
    expect(created).toMatchObject({ organizationId: 'org_a', principal: 'admin-a@example.test', organizationRole: 'admin' })

    const blockedGet = await fetch(`${privateCloud.url}/api/executor-installs/${created.id}`, { headers: orgBHeaders })
    expect(blockedGet.status).toBe(403)
    await expect(blockedGet.json()).resolves.toMatchObject({ error: 'tenant_forbidden' })

    const blockedPatch = await fetch(`${privateCloud.url}/api/executor-installs/${created.id}`, {
      method: 'PATCH',
      headers: orgBHeaders,
      body: JSON.stringify({ label: 'stolen' }),
    })
    expect(blockedPatch.status).toBe(403)

    const allowedGet = await fetch(`${privateCloud.url}/api/executor-installs/${created.id}`, { headers: orgAHeaders })
    expect(allowedGet.status).toBe(200)
    await expect(allowedGet.json()).resolves.toMatchObject({ organizationId: 'org_a', id: created.id })
  })
})
