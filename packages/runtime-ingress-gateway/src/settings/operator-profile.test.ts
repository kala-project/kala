import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { readOperatorProfile, readOperatorProtectedFile, resolveOperatorSecret } from './operator-profile.js'

const directories: string[] = []
async function fixture() {
  const path = resolve('.settings-test-work', `operator-profile-${randomUUID()}`)
  await mkdir(path, { recursive: true, mode: 0o700 })
  directories.push(path)
  return path
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe.skipIf(process.platform === 'win32')('protected Operator profiles and secret references', () => {
  it('loads a real protected exact profile and refuses broad file permissions and final symlinks', async () => {
    const root = await fixture()
    const profile = { schemaVersion: 1, installationIdFile: `${root}/installation-id`,
      controlPlaneDatabaseUrlRef: pathToFileURL(`${root}/database`).href,
      runtimeControlOrigin: 'https://runtime.private.test', internalCredentialRef: pathToFileURL(`${root}/internal`).href,
      planSigningKeyRef: pathToFileURL(`${root}/signing`).href, allowedOrganizations: ['org-a'], allowedResourceKinds: ['workspace'] }
    const path = `${root}/profile.json`
    await writeFile(path, JSON.stringify(profile), { mode: 0o600 })
    expect(await readOperatorProfile(path)).toEqual(profile)
    await symlink(path, `${root}/linked.json`)
    await expect(readOperatorProfile(`${root}/linked.json`)).rejects.toThrow('invalid_profile')
    await chmod(path, 0o640)
    await expect(readOperatorProfile(path)).rejects.toThrow('invalid_profile')
    await chmod(path, 0o600)
    await writeFile(path, JSON.stringify({ ...profile, arbitrarySql: 'not permitted' }))
    await expect(readOperatorProfile(path)).rejects.toThrow('invalid_profile')
  })

  it('reads bounded real secret bytes without leaking contents or protected path in errors', async () => {
    const root = await fixture()
    const path = `${root}/private-file`
    await writeFile(path, 'local-fictional-fixture-secret\n', { mode: 0o600 })
    expect(await resolveOperatorSecret(pathToFileURL(path).href)).toBe('local-fictional-fixture-secret')
    await expect(readOperatorProtectedFile(path, 2)).rejects.toThrow('invalid_profile')
    await expect(resolveOperatorSecret(`file://foreign.invalid${path}`)).rejects.toThrow('invalid_profile')
    await expect(resolveOperatorSecret('file:relative-secret')).rejects.toThrow('invalid_profile')
    await expect(resolveOperatorSecret('bao:protected/operator#key', { resolve: async () => {
      throw new Error(`Sensitive upstream returned ${path} local-fictional-fixture-secret`)
    } })).rejects.toThrow(/^invalid_profile$/u)
  })

  it('fails closed on empty, oversized and non-regular files', async () => {
    const root = await fixture()
    const path = `${root}/secret`
    await writeFile(path, '', { mode: 0o600 })
    await expect(resolveOperatorSecret(pathToFileURL(path).href)).rejects.toThrow('invalid_profile')
    await writeFile(path, Buffer.alloc(64 * 1024 + 1, 'x'))
    await expect(resolveOperatorSecret(pathToFileURL(path).href)).rejects.toThrow('invalid_profile')
    await expect(readOperatorProtectedFile(root)).rejects.toThrow('invalid_profile')
    await expect(readOperatorProtectedFile('relative-file')).rejects.toThrow('invalid_profile')
  })
})
