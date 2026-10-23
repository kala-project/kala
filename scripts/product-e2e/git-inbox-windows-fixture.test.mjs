import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { validateWindowsFixture, windowsFixtureRemovalScript } from './git-inbox-windows-fixture.mjs'

const fixture = {
  schemaVersion: 1, platform: 'windows', workspaceName: 'kala-clean-windows',
  fixture: 'C:\\KalaTest\\workspace\\git-inbox-12345678-1234-1234-1234-123456789abc',
  hashes: { root: 'a'.repeat(40), rename: 'b'.repeat(40), changed: 'c'.repeat(40), head: 'd'.repeat(40) },
}
test('accepts an isolated prepared Windows fixture with actual commit identifiers', () => {
  assert.deepEqual(validateWindowsFixture(fixture), fixture)
})
test('normalizes Windows paths without converting them to Linux paths', () => {
  assert.equal(validateWindowsFixture({ ...fixture, fixture: fixture.fixture.replaceAll('\\', '/') }).fixture, fixture.fixture)
})
test('rejects manifests without genuine-looking commit identifiers', () => {
  assert.throws(() => validateWindowsFixture({ ...fixture, hashes: { ...fixture.hashes, root: '--output=bad' } }))
})
test('rejects shared, nested, outside-workspace, UNC and injected fixture paths', () => {
  for (const path of ['C:\\KalaTest\\workspace', 'C:\\KalaTest\\workspace\\shared', 'C:\\KalaTest\\other\\git-inbox-12345678-1234-1234-1234-123456789abc', `${fixture.fixture}\\nested`, '\\\\server\\share\\git-inbox-12345678-1234-1234-1234-123456789abc', `${fixture.fixture}'\nWrite-Output BAD`]) {
    assert.throws(() => validateWindowsFixture({ ...fixture, fixture: path }), path)
  }
})
test('prepares one literal nonrecursive directory removal without service or install actions', () => {
  const script = windowsFixtureRemovalScript(fixture)
  assert(script.includes(`${fixture.fixture}\\will-disappear`))
  assert(script.includes('Remove-Item -LiteralPath $path -Force -ErrorAction Stop'))
  assert(script.includes('ReparsePoint'))
  assert(!/-Recurse|Stop-Service|Restart-Service|Invoke-WebRequest|Set-ItemProperty/u.test(script))
})
test('pins an official cooled portable asset with a full checksum and actual signing evidence', async () => {
  const provenance = JSON.parse(await readFile(new URL('./fixtures/git-for-windows-portable.json', import.meta.url), 'utf8'))
  assert.equal(provenance.repository, 'git-for-windows/git')
  assert.match(provenance.sha256, /^[0-9a-f]{64}$/u)
  assert.equal(new URL(provenance.downloadUrl).hostname, 'github.com')
  assert(provenance.downloadUrl.includes(`/releases/download/${provenance.releaseTag}/`))
  assert.equal(provenance.detachedSignatureAssetProvided, false)
  assert.equal(provenance.authenticodeVerification.status, 'Valid')
  assert.equal(provenance.minimumReleaseAgeHours, 24)
  assert(provenance.authenticodeVerification.method.includes('actual isolated Windows 11'))
})
