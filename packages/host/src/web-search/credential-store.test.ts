import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { LocalWebSearchCredentialStore } from './credential-store.js'

const TEST_KEY = 'test-serper-credential-value'

describe('LocalWebSearchCredentialStore', () => {
  it('encrypts credentials, applies private permissions, and survives restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-search-credentials-'))
    const directory = join(root, 'credentials')
    const store = new LocalWebSearchCredentialStore(directory)

    expect(await store.status()).toEqual({ configured: false, provider: 'serper' })
    const status = await store.set('serper', TEST_KEY)
    expect(status).toMatchObject({ configured: true, provider: 'serper' })

    const encrypted = await readFile(join(directory, 'state.sqlite'))
    expect(encrypted).not.toContain(TEST_KEY)
    expect((await readFile(join(directory, 'state-store.key'))).length).toBe(32)
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, 'state-store.key'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(directory, 'state.sqlite'))).mode & 0o777).toBe(0o600)
    }

    const restarted = new LocalWebSearchCredentialStore(directory)
    expect(await restarted.get('serper')).toBe(TEST_KEY)
    expect(await restarted.status()).toEqual(status)
    expect(await restarted.delete('serper')).toEqual({ configured: false, provider: 'serper' })
    expect(await restarted.get('serper')).toBeUndefined()
  })

  it('uses the encrypted authority revision for conditional set/delete and sanitized reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'web-search-cas-'))
    const first = new LocalWebSearchCredentialStore(root)
    const second = new LocalWebSearchCredentialStore(root)
    expect(await first.configuration()).toEqual({ revision: '1', value: { configured: false, provider: 'serper' } })
    await first.set('serper', TEST_KEY, { expectedRevision: '1' })
    await expect(second.set('serper', 'stale-replacement', { expectedRevision: '1' })).rejects.toThrow('configuration_conflict')
    await expect(second.delete('serper', { writeProtocol: 'conditional-required' })).rejects.toThrow('client_upgrade_required')
    expect(await first.get('serper')).toBe(TEST_KEY)
    expect(await second.configuration()).toMatchObject({ revision: '2', value: { configured: true } })
    expect(JSON.stringify(await second.configuration())).not.toContain(TEST_KEY)
    await second.delete('serper', { expectedRevision: '2' })
    expect(await first.configuration()).toEqual({ revision: '3', value: { configured: false, provider: 'serper' } })
  })
})
