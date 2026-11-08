import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { buildDedicatedSupportBundle, DEDICATED_SUPPORT_ARCHIVE } from '../release/dedicated-support-bundle.mjs'

const builder = fileURLToPath(new URL('./build-dedicated-local-bridge.mjs', import.meta.url))
const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const localAssets = [
  'kala-dashboard-with-runtime.cjs', 'kala-runtime.cjs', 'kala-executor.cjs',
  'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs',
  'kala-dashboard.tar.gz', 'kala-docs.tar.gz', DEDICATED_SUPPORT_ARCHIVE,
  'kala-release-metadata.tar.gz', 'run.sh', 'kala-dedicated.mjs', 'kala-model-catalog-seed.json',
]
const oldControlAssets = [
  'bundle-dashboard-with-runtime.cjs', 'agent-runlab-runtime.cjs', 'agent-kernel-executor.cjs',
  'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs',
]
const oldUnits = [
  'kala-dedicated-ingress.service', 'kala-dedicated-unit@.service',
  'kala-dedicated-deploy-supervisor.service', 'kala-dedicated-control-updater.service',
  'kala-dedicated-migration-finalizer.service',
]
const aliasPairs = [
  ['bundle-dashboard-with-runtime.cjs', 'kala-dashboard-with-runtime.cjs'],
  ['agent-runlab-runtime.cjs', 'kala-runtime.cjs'],
  ['agent-kernel-executor.cjs', 'kala-executor.cjs'],
  ['kala-dedicated-ingress.cjs', 'kala-dedicated-ingress.cjs'],
  ['kala-dedicated-deploy-supervisor.cjs', 'kala-dedicated-deploy-supervisor.cjs'],
]

const roots = []
test.afterEach(async () => { for (const root of roots.splice(0)) await makeRemovable(root).then(() => rm(root, { recursive: true, force: true })) })

test('CLI reproducibly builds a checksummed old-layout bridge without modifying either input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dedicated-local-bridge-')); roots.push(root)
  const legacy = await createLegacy(join(root, 'legacy'))
  const local = await createLocal(join(root, 'local'))
  const legacyBefore = await snapshot(legacy.path)
  const localBefore = await snapshot(local.path)
  const first = join(root, 'bridge-a'), second = join(root, 'bridge-b')

  const result = await runBuilder(legacy.path, local.path, first)
  assert.equal(result.code, 0, result.stderr)
  const built = JSON.parse(result.stdout)
  assert.match(built.releaseDigest, /^[a-f0-9]{64}$/u)
  assert.deepEqual(await snapshot(legacy.path), legacyBefore)
  assert.deepEqual(await snapshot(local.path), localBefore)

  await runBuilder(legacy.path, local.path, second).then((again) => assert.equal(again.code, 0, again.stderr))
  assert.deepEqual(await snapshot(first), await snapshot(second))
  const manifest = JSON.parse(await readFile(join(first, 'manifest.json'), 'utf8'))
  assert.equal(manifest.localDevelopmentBridge.legacyReleaseDigest, legacy.digest)
  assert.equal(manifest.localDevelopmentBridge.localReleaseDigest, local.digest)
  assert.equal(manifest.assets.includes('kala-release-metadata.tar.gz'), false)
  assert.equal((await readdir(first)).includes('SHA256SUMS.sigstore.json'), false)
  for (const [oldName, newName] of aliasPairs) assert.deepEqual(await readFile(join(first, oldName)), await readFile(join(first, newName)))
  await verifySums(first)
})

test('builder rejects tampering, non-exact local layouts, mutable legacy input, and overlapping output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dedicated-local-bridge-invalid-')); roots.push(root)
  const legacy = await createLegacy(join(root, 'legacy'))
  const local = await createLocal(join(root, 'local'))
  await writeFile(join(local.path, 'kala-runtime.cjs'), 'tampered')
  await assert.rejects(buildViaImport(legacy.path, local.path, join(root, 'tampered')), /checksum mismatch/u)

  const localExtra = await createLocal(join(root, 'local-extra'), ['unexpected.cjs'])
  await assert.rejects(buildViaImport(legacy.path, localExtra.path, join(root, 'extra')), /exact 14-file|file set is not exact/u)

  await chmod(legacy.path, 0o755)
  await assert.rejects(buildViaImport(legacy.path, localExtra.path, join(root, 'mutable')), /immutable/u)
  await chmod(legacy.path, 0o555)
  await assert.rejects(buildViaImport(legacy.path, localExtra.path, join(legacy.path, 'output')), /must not overlap/u)
})

async function buildViaImport(legacyReleaseDir, localReleaseDir, outputDir) {
  const { buildDedicatedLocalBridge } = await import('./build-dedicated-local-bridge.mjs')
  return await buildDedicatedLocalBridge({ legacyReleaseDir, localReleaseDir, outputDir })
}

async function createLegacy(path) {
  await mkdir(path)
  const assets = [...oldControlAssets, ...oldUnits, 'deployment.json', 'update-dedicated-control-plane.mjs', 'agent-kernel-dashboard-dist.tar.gz', 'dashboard-release.json']
  for (const name of assets) await writeFile(join(path, name), `legacy:${name}\n`)
  const manifest = {
    name: 'kala', version: '0.2.0-rc.12', assets,
    fallbackAssets: {
      'agent-kernel-host': 'bundle-dashboard-with-runtime.cjs',
      'agent-runlab-runtime': 'agent-runlab-runtime.cjs',
      'agent-kernel-executor': 'agent-kernel-executor.cjs',
      'kala-dedicated-ingress': 'kala-dedicated-ingress.cjs',
      'kala-dedicated-deploy-supervisor': 'kala-dedicated-deploy-supervisor.cjs',
    },
  }
  await writeFile(join(path, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(path, 'RELEASE_NOTES.md'), '# legacy\n')
  const digest = await writeSums(path, [...assets, 'manifest.json', 'RELEASE_NOTES.md'])
  for (const name of await readdir(path)) await chmod(join(path, name), 0o444)
  await chmod(path, 0o555)
  return { path, digest }
}

async function createLocal(path, extra = []) {
  await mkdir(path)
  for (const name of [...localAssets, ...extra]) if (name !== DEDICATED_SUPPORT_ARCHIVE) await writeFile(join(path, name), `local:${name}\n`)
  buildDedicatedSupportBundle({ root: repositoryRoot, output: join(path, DEDICATED_SUPPORT_ARCHIVE) })
  const assets = [...localAssets, ...extra]
  await writeFile(join(path, 'manifest.json'), `${JSON.stringify({ localDevelopment: true, source: { dirty: true }, assets }, null, 2)}\n`)
  const digest = await writeSums(path, [...assets, 'manifest.json'])
  return { path, digest }
}

async function writeSums(path, names) {
  const sums = `${(await Promise.all([...names].sort().map(async (name) => `${sha256(await readFile(join(path, name)))}  ${name}`))).join('\n')}\n`
  await writeFile(join(path, 'SHA256SUMS'), sums)
  return sha256(Buffer.from(sums))
}
async function verifySums(path) {
  for (const line of (await readFile(join(path, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
    const [, digest, name] = /^([a-f0-9]{64})  (.+)$/u.exec(line)
    assert.equal(sha256(await readFile(join(path, name))), digest)
  }
}
async function snapshot(path) { const result = {}; for (const name of (await readdir(path)).sort()) result[name] = sha256(await readFile(join(path, name))); return result }
async function makeRemovable(path) { await chmod(path, 0o700).catch(() => undefined); for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await makeRemovable(join(path, entry.name)); else await chmod(join(path, entry.name), 0o600).catch(() => undefined) }
function runBuilder(legacy, local, output) { return new Promise((resolveRun, reject) => { const child = spawn(process.execPath, [builder, '--legacy-release-dir', legacy, '--local-release-dir', local, '--output-dir', output], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => { stdout += chunk }); child.stderr.on('data', (chunk) => { stderr += chunk }); child.once('error', reject); child.once('exit', (code) => resolveRun({ code, stdout, stderr })) }) }
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
