#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { collectRcEvidence, requiredReleaseEvidence, verifyRcEvidenceSet } from './rc-evidence.mjs'
import { verifyReleaseChecksums } from './release-checksums.mjs'
import { windowsServiceHostManifestMetadata } from './windows-service-host.mjs'
import { POSIX_PORTABLE_MANAGER, WINDOWS_PORTABLE_MANAGER } from './portable-manager.mjs'

const directory = resolve(required('--directory'))
const evidenceDirectory = resolve(required('--evidence'))
const aggregatePath = resolve(required('--aggregate'))
const tag = required('--tag')
const revision = required('--revision')
const manifest = json(join(directory, 'manifest.json'))
const targets = [...requiredReleaseEvidence.portable.targets]
const nativeExecutorAssets = targets.map((target) => target === 'win32-x64' ? 'kala-executor-win32-x64.exe' : `kala-executor-${target}`)
const windowsAssets = ['node-pty-win32-x64.tar.gz', 'kala-executor-service-host-win32-x64.exe', 'install-executor.ps1']
const expectedAssets = [
  ...nativeExecutorAssets,
  ...windowsAssets,
  ...targets.flatMap((target) => [`kala-copilot-runtime-${target}`, `kala-copilot-runtime-node-${target}.node`]),
  'kala-dashboard-with-runtime.cjs', 'kala-runtime.cjs', 'kala-executor.cjs', 'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs',
  'kala-dashboard.tar.gz', 'kala-docs.tar.gz', 'kala-dedicated-support.tar.gz', 'kala-release-metadata.tar.gz',
  'run.sh', POSIX_PORTABLE_MANAGER, WINDOWS_PORTABLE_MANAGER, 'kala-dedicated.mjs', 'kala-model-catalog-seed.json',
].sort()

if (manifest.version !== tag.slice(1)) fail('current release manifest version does not match the promoted tag')
if (manifest.source?.revision !== revision) fail('current release manifest revision does not match the promoted revision')
if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) fail('current release manifest has no assets')
if (JSON.stringify(manifest.windowsServiceHost) !== JSON.stringify(windowsServiceHostManifestMetadata())) {
  fail('current release manifest does not identify the pinned Windows service host')
}
assertUnique(manifest.assets, 'current release manifest assets')
if (JSON.stringify([...manifest.assets].sort()) !== JSON.stringify(expectedAssets)) fail('current release manifest does not contain the exact checksummed assets')
if (!Array.isArray(manifest.nativeTargets) || JSON.stringify([...manifest.nativeTargets].sort()) !== JSON.stringify([...targets].sort())) {
  fail('current release manifest does not contain exactly the four supported native Executor targets')
}
const expectedNativeAssets = {
  'kala-host': [], 'kala-runtime': [],
  'kala-executor': nativeExecutorAssets,
  'kala-dedicated-ingress': [], 'kala-dedicated-deploy-supervisor': [],
}
if (JSON.stringify(manifest.nativeAssets) !== JSON.stringify(expectedNativeAssets)) fail('candidate contains unexpected native binaries')

const aggregateName = basename(aggregatePath)
if (aggregateName !== 'rc-evidence.json') fail('aggregate evidence must be named rc-evidence.json')
const expectedFiles = [...expectedAssets, 'manifest.json', 'SHA256SUMS', 'SHA256SUMS.sigstore.json'].sort()
assertUnique(expectedFiles, 'promotion release inventory')
const entries = readdirSync(directory, { withFileTypes: true })
if (entries.some((entry) => !entry.isFile())) fail('current release inventory contains a non-file')
const actualFiles = entries.map((entry) => entry.name).sort()
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  fail(`current release inventory is not closed; expected ${JSON.stringify(expectedFiles)}, received ${JSON.stringify(actualFiles)}`)
}
if (aggregatePath.startsWith(`${directory}/`) || aggregatePath === directory) fail('aggregate evidence must remain outside the signed release inventory')

await verifyReleaseChecksums(directory, [...manifest.assets, 'manifest.json'])
const evidence = verifyRcEvidenceSet(collectRcEvidence(evidenceDirectory), { tag, revision })
for (const target of targets) {
  const record = evidence.find((entry) => entry.category === 'portable' && entry.target === target)
  const name = 'kala-dashboard-with-runtime.cjs'
  if (!record || record.artifact.name !== name) fail(`validated ${target} evidence does not identify ${name}`)
  if (!manifest.assets.includes(name)) fail(`current release manifest is missing accepted Portable CJS asset ${name}`)
  if (digest(readFileSync(join(directory, name))) !== record.artifact.sha256) {
    fail(`current release asset ${name} differs from its validated acceptance evidence`)
  }
  if (target === 'win32-x64') {
    for (const accepted of record.artifacts) {
      if (!manifest.assets.includes(accepted.name)) fail(`current release manifest is missing accepted Windows asset ${accepted.name}`)
      if (digest(readFileSync(join(directory, accepted.name))) !== accepted.sha256) fail(`current release asset ${accepted.name} differs from its validated acceptance evidence`)
    }
  }
}
console.log(`verified closed promotion candidate for ${tag} at ${revision}`)

function digest(value) { return createHash('sha256').update(value).digest('hex') }
function json(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { fail(`invalid JSON file: ${basename(path)}`) } }
function assertUnique(values, label) { if (new Set(values).size !== values.length) fail(`${label} contains duplicate names`) }
function required(name) { const index = process.argv.indexOf(name); const value = index < 0 ? undefined : process.argv[index + 1]; if (!value) fail(`missing ${name}`); return value }
function fail(message) { throw new Error(message) }
