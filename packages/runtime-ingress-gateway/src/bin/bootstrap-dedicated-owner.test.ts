import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readProtectedOwnerPassword } from './bootstrap-dedicated-owner.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('Dedicated Owner bootstrap secret', () => {
  it('reads a mode-0600 regular file without retaining its trailing newline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-owner-secret-')); roots.push(root)
    const path = join(root, 'password')
    await writeFile(path, 'correct horse battery staple\n', { mode: 0o600 })
    await expect(readProtectedOwnerPassword(path)).resolves.toBe('correct horse battery staple')
  })

  it('rejects broadly readable files and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dedicated-owner-secret-')); roots.push(root)
    const path = join(root, 'password')
    await writeFile(path, 'not accepted', { mode: 0o600 })
    if (process.platform !== 'win32') {
      await chmod(path, 0o640)
      await expect(readProtectedOwnerPassword(path)).rejects.toThrow('must not be accessible')
      await chmod(path, 0o600)
    }
    const link = join(root, 'password-link')
    await symlink(path, link)
    await expect(readProtectedOwnerPassword(link)).rejects.toThrow('not a symlink')
  })
})
