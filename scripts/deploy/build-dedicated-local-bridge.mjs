#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { DEDICATED_SUPPORT_ARCHIVE, DEDICATED_SUPPORT_ASSETS, extractDedicatedSupportBundle, inspectDedicatedSupportBundle } from '../release/dedicated-support-bundle.mjs'

const localAssets = [
  'kala-dashboard-with-runtime.cjs', 'kala-runtime.cjs', 'kala-executor.cjs',
  'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs',
  'kala-dashboard.tar.gz', 'kala-docs.tar.gz', DEDICATED_SUPPORT_ARCHIVE,
  'kala-release-metadata.tar.gz', 'run.sh', 'kala-dedicated.mjs', 'kala-model-catalog-seed.json',
]
const controlAliases = new Map([
  ['bundle-dashboard-with-runtime.cjs', 'kala-dashboard-with-runtime.cjs'],
  ['agent-runlab-runtime.cjs', 'kala-runtime.cjs'],
  ['agent-kernel-executor.cjs', 'kala-executor.cjs'],
  ['kala-dedicated-ingress.cjs', 'kala-dedicated-ingress.cjs'],
  ['kala-dedicated-deploy-supervisor.cjs', 'kala-dedicated-deploy-supervisor.cjs'],
])
const bridgeAssets = [...controlAliases.values(), DEDICATED_SUPPORT_ARCHIVE]
const oldUnits = [
  'kala-dedicated-ingress.service', 'kala-dedicated-unit@.service',
  'kala-dedicated-deploy-supervisor.service', 'kala-dedicated-control-updater.service',
  'kala-dedicated-migration-finalizer.service',
]
const oldUpdaterAssets = [...oldUnits, 'deployment.json', 'update-dedicated-control-plane.mjs', 'agent-kernel-dashboard-dist.tar.gz', 'dashboard-release.json']

export async function buildDedicatedLocalBridge({ legacyReleaseDir, localReleaseDir, outputDir }) {
  const legacy = resolveRequired(legacyReleaseDir, 'legacy release directory')
  const local = resolveRequired(localReleaseDir, 'local release directory')
  const output = resolveRequired(outputDir, 'output directory')
  assertDisjoint(output, legacy, 'legacy release directory')
  assertDisjoint(output, local, 'local release directory')
  await assertMissing(output)

  const legacyRelease = await verifyLegacyRelease(legacy)
  const localRelease = await verifyLocalRelease(local)
  const support = inspectDedicatedSupportBundle(join(local, DEDICATED_SUPPORT_ARCHIVE))
  const parent = dirname(output)
  await mkdir(parent, { recursive: true })
  const incoming = join(parent, `.${basename(output)}.incoming-${process.pid}-${randomBytes(8).toString('hex')}`)
  const supportDir = join(parent, `.${basename(output)}.support-${process.pid}-${randomBytes(8).toString('hex')}`)
  await mkdir(incoming, { mode: 0o700 })
  await mkdir(supportDir, { mode: 0o700 })
  try {
    extractDedicatedSupportBundle(join(local, DEDICATED_SUPPORT_ARCHIVE), supportDir)
    const replaced = new Set([...controlAliases.keys(), ...DEDICATED_SUPPORT_ASSETS])
    for (const name of legacyRelease.assets) if (!replaced.has(name)) await copyFile(join(legacy, name), join(incoming, name))
    await copyFile(join(legacy, 'RELEASE_NOTES.md'), join(incoming, 'RELEASE_NOTES.md'))

    // Keep the old filenames and service files that the installed legacy updater
    // understands, but put the current control code behind those names.
    for (const [oldName, newName] of controlAliases) {
      if (!legacyRelease.assets.includes(oldName)) throw new Error(`legacy release is missing required bridge asset: ${oldName}`)
      await copyFile(join(local, newName), join(incoming, oldName))
      await copyFile(join(local, newName), join(incoming, newName))
    }
    for (const name of oldUpdaterAssets) if (!legacyRelease.assets.includes(name)) throw new Error(`legacy release is missing required bridge asset: ${name}`)

    // Common support files must equal the archive. This lets the new updater
    // materialize one collision-free snapshot while the old updater still sees
    // every flat file it requires.
    for (const name of DEDICATED_SUPPORT_ASSETS) {
      if (legacyRelease.assets.includes(name)) await copyFile(join(supportDir, name), join(incoming, name))
    }
    await copyFile(join(local, DEDICATED_SUPPORT_ARCHIVE), join(incoming, DEDICATED_SUPPORT_ARCHIVE))

    const assets = [...new Set([...legacyRelease.assets, ...bridgeAssets])].sort()
    const manifest = {
      ...legacyRelease.manifest,
      assets,
      localDevelopmentBridge: {
        schemaVersion: 1,
        legacyReleaseDigest: legacyRelease.digest,
        localReleaseDigest: localRelease.digest,
      },
    }
    await writeFile(join(incoming, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    const checksummed = [...assets, 'manifest.json', 'RELEASE_NOTES.md'].sort()
    const sums = `${(await Promise.all(checksummed.map(async (name) => `${sha256(await readFile(join(incoming, name)))}  ${name}`))).join('\n')}\n`
    await writeFile(join(incoming, 'SHA256SUMS'), sums, { mode: 0o600 })
    await verifyBridge(incoming, legacyRelease.digest, localRelease.digest, support.sha256)
    for (const name of [...checksummed, 'SHA256SUMS']) {
      const path = join(incoming, name)
      await chmod(path, 0o444 | ((await lstat(path)).mode & 0o111))
    }
    await chmod(incoming, 0o555)
    await rename(incoming, output)
    return { outputDir: output, releaseDigest: sha256(Buffer.from(sums)), assets: assets.length }
  } finally {
    await makeRemovable(incoming)
    await makeRemovable(supportDir)
    await rm(incoming, { recursive: true, force: true })
    await rm(supportDir, { recursive: true, force: true })
  }
}

async function verifyLegacyRelease(root) {
  const { manifest, assets, digest } = await verifyChecksummedRelease(root, true)
  if (!assets.includes('agent-runlab-runtime.cjs') || !assets.includes('kala-dedicated-unit@.service')) throw new Error('legacy release does not have the required old-name layout')
  if (manifest.fallbackAssets?.['agent-runlab-runtime'] !== 'agent-runlab-runtime.cjs') throw new Error('legacy release Runtime fallback is invalid')
  return { manifest, assets, digest }
}

async function verifyLocalRelease(root) {
  const { manifest, assets, digest } = await verifyChecksummedRelease(root, false)
  if (manifest.localDevelopment !== true) throw new Error('local release is not marked localDevelopment')
  if (JSON.stringify([...assets].sort()) !== JSON.stringify([...localAssets].sort())) throw new Error('local release does not have the exact 14-file candidate layout')
  inspectDedicatedSupportBundle(join(root, DEDICATED_SUPPORT_ARCHIVE))
  return { manifest, assets, digest }
}

async function verifyChecksummedRelease(root, legacy, requireImmutable = legacy) {
  const directory = await lstat(root)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('release path must be a real directory')
  if (requireImmutable && (directory.mode & 0o222) !== 0) throw new Error('legacy release directory must be immutable')
  const manifestBytes = await readFile(join(root, 'manifest.json'))
  const manifest = JSON.parse(String(manifestBytes))
  if (!manifest || !Array.isArray(manifest.assets) || manifest.assets.some((name) => !safeName(name)) || new Set(manifest.assets).size !== manifest.assets.length) throw new Error('release manifest assets are invalid')
  const assets = manifest.assets
  const expected = [...assets, 'manifest.json', 'SHA256SUMS', ...(legacy ? ['RELEASE_NOTES.md'] : [])].sort()
  const entries = await readdir(root, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) || JSON.stringify(entries.map((entry) => entry.name).sort()) !== JSON.stringify(expected)) throw new Error('release file set is not exact')
  const sumsBytes = await readFile(join(root, 'SHA256SUMS'))
  const sums = parseSums(String(sumsBytes))
  const checksummed = [...assets, 'manifest.json', ...(legacy ? ['RELEASE_NOTES.md'] : [])].sort()
  if (JSON.stringify([...sums.keys()].sort()) !== JSON.stringify(checksummed)) throw new Error('release checksum file set is not exact')
  for (const name of checksummed) {
    const stat = await lstat(join(root, name))
    if (!stat.isFile() || stat.isSymbolicLink() || requireImmutable && (stat.mode & 0o222) !== 0) throw new Error(`release asset is not immutable: ${name}`)
    if (sha256(await readFile(join(root, name))) !== sums.get(name)) throw new Error(`release checksum mismatch: ${name}`)
  }
  return { manifest, assets, digest: sha256(sumsBytes) }
}

async function verifyBridge(root, legacyDigest, localDigest, supportDigest) {
  // The bridge has the legacy notes layout but is made immutable only after
  // this complete content verification succeeds.
  const verified = await verifyChecksummedRelease(root, true, false)
  const marker = verified.manifest.localDevelopmentBridge
  if (marker?.schemaVersion !== 1 || marker.legacyReleaseDigest !== legacyDigest || marker.localReleaseDigest !== localDigest) throw new Error('bridge provenance is invalid')
  if (sha256(await readFile(join(root, DEDICATED_SUPPORT_ARCHIVE))) !== supportDigest) throw new Error('bridge support archive mismatch')
}

function parseSums(text) {
  const result = new Map()
  for (const line of text.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._@-]*)$/u.exec(line)
    if (!match || result.has(match[2])) throw new Error('invalid SHA256SUMS')
    result.set(match[2], match[1])
  }
  return result
}
function safeName(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._@-]*$/u.test(value) && basename(value) === value }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function resolveRequired(value, label) { if (!value) throw new Error(`${label} is required`); return resolve(value) }
function contains(parent, child) { const path = relative(parent, child); return path === '' || path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) }
function assertDisjoint(output, input, label) { if (contains(output, input) || contains(input, output)) throw new Error(`output directory must not overlap ${label}`) }
async function assertMissing(path) { try { await lstat(path); throw new Error('output directory already exists') } catch (error) { if (error?.code !== 'ENOENT') throw error } }
async function makeRemovable(path) { await chmod(path, 0o700).catch(() => undefined); for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await makeRemovable(join(path, entry.name)); else await chmod(join(path, entry.name), 0o600).catch(() => undefined) }

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1]
    if (!['--legacy-release-dir', '--local-release-dir', '--output-dir'].includes(flag) || !value) throw new Error('Usage: build-dedicated-local-bridge.mjs --legacy-release-dir DIR --local-release-dir DIR --output-dir DIR')
    if (values[flag]) throw new Error(`duplicate option: ${flag}`)
    values[flag] = value
  }
  return { legacyReleaseDir: values['--legacy-release-dir'], localReleaseDir: values['--local-release-dir'], outputDir: values['--output-dir'] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildDedicatedLocalBridge(parseArgs(process.argv.slice(2))).then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
