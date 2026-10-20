import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ExecutorInstallationError, ExecutorInstallationStore } from './executor-installation.js'

describe('ExecutorInstallationStore', () => {
  it('persists only a bootstrap hash and resumes status after reload', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'executor-installs-')), 'installs.json')
    const store = new ExecutorInstallationStore(path)
    const created = await store.create({ platform: 'linux', mode: 'service', privilegeMode: 'privileged', workspaceRoot: '/work' })
    expect(readFileSync(path, 'utf8')).not.toContain(created.setupCode)
    expect(readFileSync(path, 'utf8')).toContain('sha256:')

    const claimed = await store.claim(created.setupCode)
    expect(claimed?.install.status).toBe('bootstrap_downloaded')
    const bootstrap = claimed!.bootstrap
    expect((await store.reportClient(created.install.id, bootstrap, 'asset_verified')).seq).toBe(2)
    expect((await store.reportClient(created.install.id, bootstrap, 'pairing_pending')).status).toBe('paired')
    expect((await store.reportClient(created.install.id, bootstrap, 'service_installing')).status).toBe('service_installing')
    expect((await store.reportClient(created.install.id, bootstrap, 'starting')).status).toBe('starting')

    const reloaded = new ExecutorInstallationStore(path)
    await reloaded.load()
    expect((await reloaded.get(created.install.id))?.status).toBe('starting')
  })

  it('loads legacy records without escalating missing privilege modes and rejects invalid explicit modes', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'executor-installs-')), 'installs.json')
    const store = new ExecutorInstallationStore(path)
    const created = await store.create({ platform: 'linux', mode: 'service', privilegeMode: 'privileged', workspaceRoot: '/work' })
    const value = JSON.parse(readFileSync(path, 'utf8')) as { installations: Array<Record<string, unknown>> }
    delete value.installations[0]!.privilegeMode
    writeFileSync(path, JSON.stringify(value))
    const migrated = new ExecutorInstallationStore(path)
    await migrated.load()
    expect((await migrated.get(created.install.id))?.privilegeMode).toBe('restricted')
    value.installations[0]!.privilegeMode = 'root'
    writeFileSync(path, JSON.stringify(value))
    await expect(new ExecutorInstallationStore(path).load()).rejects.toThrow('requires a valid privilegeMode')
  })

  it('redeems once and only host observation can complete', async () => {
    const store = new ExecutorInstallationStore(join(mkdtempSync(join(tmpdir(), 'executor-installs-')), 'installs.json'))
    const created = await store.create({ platform: 'macos', mode: 'temporary', privilegeMode: 'privileged', workspaceRoot: '/work' })
    const bootstrap = (await store.claim(created.setupCode))!.bootstrap
    await store.reportClient(created.install.id, bootstrap, 'asset_verified')
    expect((await store.reportClient(created.install.id, bootstrap, 'pairing_pending')).status).toBe('paired')
    await store.redeem(created.install.id, bootstrap, 'ws-1')
    await expect(store.redeem(created.install.id, bootstrap, 'ws-1')).rejects.toBeInstanceOf(ExecutorInstallationError)
    await store.reportClient(created.install.id, bootstrap, 'starting')
    await expect(store.reportClient(created.install.id, bootstrap, 'online')).rejects.toThrow('host_observed_status_required')
    expect(await store.markOnline(created.install.id, 'wrong')).toBeUndefined()
    expect((await store.markOnline(created.install.id, 'ws-1'))?.status).toBe('completed')
    expect((await store.events(created.install.id))?.map((event) => event.status)).toContain('online')
  })
})
