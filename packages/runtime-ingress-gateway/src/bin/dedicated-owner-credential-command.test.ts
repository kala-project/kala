import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

import { readPrivatePasswordFile } from './dedicated-owner-credential-command.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('Dedicated Owner credential command inputs', () => {
  it('reads a private regular file and strips only trailing line endings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owner-credential-')); roots.push(root)
    const path = join(root, 'password')
    await writeFile(path, ' replacement password \n', { mode: 0o600 })
    await expect(readPrivatePasswordFile(path, 'fixture', false)).resolves.toBe(' replacement password ')
    if (process.platform !== 'win32' && process.getuid?.() === 0) {
      await expect(readPrivatePasswordFile(path, 'fixture', true)).resolves.toBe(' replacement password ')
    }
  })

  it('rejects broadly readable files and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'owner-credential-')); roots.push(root)
    const path = join(root, 'password')
    await writeFile(path, 'replacement password', { mode: 0o600 })
    if (process.platform !== 'win32') {
      await chmod(path, 0o640)
      await expect(readPrivatePasswordFile(path, 'fixture', false)).rejects.toThrow('must not be accessible')
      await chmod(path, 0o600)
    }
    const link = join(root, 'password-link')
    await symlink(path, link)
    await expect(readPrivatePasswordFile(link, 'fixture', false)).rejects.toThrow('not a symlink')
  })
})
