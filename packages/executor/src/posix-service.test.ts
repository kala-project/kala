import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { installPosixService, macosServiceDefinition, manageMacosService } from './posix-service.js'
import type { InstallerSession } from './installer-session.js'

describe('POSIX organization service installation', () => {
  it('installs a private macOS credential and launchd service with the enrolled routing identity', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kala-launchd-install-'))
    try {
      const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
      const options = { platform: 'darwin' as const, architecture: 'arm64', home, uid: 501, runner: { run } }
      const session: InstallerSession = {
        version: 1, mode: 'user', privilegeMode: 'privileged', executable: join(home, 'managed/current/kala-executor'),
        host: 'https://kala.example.test', sandboxRoots: [join(home, 'workspace')],
        credential: { token: 'enrolled-private-token' }, workspaceId: 'ws_enrolled',
        routeHint: 'saved-invite-route', installationSource: 'private-cloud-invite',
      }
      await installPosixService(session, options)
      const definition = macosServiceDefinition('user', options)
      const config = JSON.parse(readFileSync(definition.configPath, 'utf8'))
      expect(config).toMatchObject({ workspaceId: 'ws_enrolled', routeHint: 'saved-invite-route', installationSource: 'private-cloud-invite' })
      expect(statSync(definition.configPath).mode & 0o777).toBe(0o600)
      expect(statSync(config.credentialFile).mode & 0o777).toBe(0o600)
      expect(readFileSync(config.credentialFile, 'utf8')).toBe('enrolled-private-token\n')
      expect(readFileSync(definition.plistPath, 'utf8')).not.toContain('enrolled-private-token')
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ file: '/bin/launchctl', args: expect.arrayContaining(['bootstrap', 'gui/501']) }))
      await expect(installPosixService(session, options)).rejects.toThrow(/existing/)
      await manageMacosService('status', 'user', options)
      expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ args: ['print', 'gui/501/com.kala.executor'] }))
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('rejects unsupported restricted macOS services before creating files or running commands', async () => {
    const run = vi.fn()
    await expect(installPosixService({
      version: 1, mode: 'user', privilegeMode: 'restricted', executable: '/executor',
      host: 'https://kala.example.test', sandboxRoots: [], credential: { token: 'private' },
    }, { platform: 'darwin', architecture: 'arm64', home: '/not-written', uid: 501, runner: { run } })).rejects.toThrow(/Linux only/)
    expect(run).not.toHaveBeenCalled()
  })
})
