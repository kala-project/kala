import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileLoginStateStore, resolveLoginStateStoreKind } from './login-state-store.js'
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))
describe('FileLoginStateStore', () => {
  it('survives restart and consumes PKCE state only once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'login-state-')); roots.push(root); const path = join(root, 'states.json')
    const store = new FileLoginStateStore(path); await store.put('nonce', { codeVerifier: 'v', state: 's', redirectUri: 'http://x', expiresAt: Date.now() + 60_000 })
    const restored = new FileLoginStateStore(path); await restored.load()
    await expect(restored.take('nonce')).resolves.toMatchObject({ state: 's' })
    await expect(restored.take('nonce')).resolves.toBeUndefined()
  })
})

describe('resolveLoginStateStoreKind', () => {
  it('keeps file storage as the legacy default and accepts an explicit PostgreSQL selection', () => {
    expect(resolveLoginStateStoreKind({})).toBe('file')
    expect(resolveLoginStateStoreKind({ KALA_INGRESS_LOGIN_STATE_STORE_KIND: ' postgres ' })).toBe('postgres')
  })

  it('rejects ambiguous store kinds', () => {
    expect(() => resolveLoginStateStoreKind({ KALA_INGRESS_LOGIN_STATE_STORE_KIND: 'shared' })).toThrow(
      'KALA_INGRESS_LOGIN_STATE_STORE_KIND must be file or postgres',
    )
  })
})
