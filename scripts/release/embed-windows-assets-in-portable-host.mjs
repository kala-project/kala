#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateExecutorInstallerPowerShell, windowsExecutorInstallerAssetName } from './executor-installer.mjs'
import { dashboardArchiveName, readExactTarGz, verifyDashboardArchive } from './release-archives.mjs'
import { windowsNodePtyCompanionAssetName, WINDOWS_EXECUTOR_TARGET } from './windows-executor-packager.mjs'
import { WINDOWS_SERVICE_HOST } from './windows-service-host.mjs'

export const PORTABLE_HOST_ASSET = 'kala-dashboard-with-runtime.cjs'
export const WINDOWS_INSTALL_PAYLOADS = Object.freeze([
  'kala-executor.cjs',
  WINDOWS_SERVICE_HOST.asset,
  windowsNodePtyCompanionAssetName(WINDOWS_EXECUTOR_TARGET),
  windowsExecutorInstallerAssetName(),
])

const EMBEDDED_PREFIX = 'globalThis.__KALA_EMBEDDED_RELEASE_ASSETS__='
const DASHBOARD_PREFIX = 'globalThis.__KALA_EMBEDDED_DASHBOARD__='
const BUILD_INFO_PREFIX = 'globalThis.__KALA_BUILD_INFO__='
const SAFE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

export function embedWindowsAssetsInPortableHost({ directory, repo, tag, expectedRevision, canonicalDashboard = false }) {
  const releaseDir = resolve(directory)
  assertReleaseIdentity(releaseDir, { repo, tag, expectedRevision })

  const installer = windowsExecutorInstallerAssetName()
  const installerBytes = Buffer.from(generateExecutorInstallerPowerShell({ repo, tag }))
  for (const name of WINDOWS_INSTALL_PAYLOADS) {
    if (name !== installer) assertRegularFile(join(releaseDir, name), name)
  }

  const hostPath = join(releaseDir, PORTABLE_HOST_ASSET)
  assertRegularFile(hostPath, PORTABLE_HOST_ASSET)
  const mode = statSync(hostPath).mode
  let source = readFileSync(hostPath, 'utf8')
  const buildInfo = parseBannerJson(source, BUILD_INFO_PREFIX, 'Portable Host build info')
  if (buildInfo.releaseTag !== tag) throw new Error(`Portable Host release tag mismatch: expected ${tag}`)
  if (buildInfo.gitCommit !== expectedRevision.slice(0, 12)) throw new Error('Portable Host source revision mismatch')

  if (canonicalDashboard) {
    const archive = join(releaseDir, dashboardArchiveName)
    const dashboard = verifyDashboardArchive(archive).manifest
    const release = JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf8'))
    if (dashboard.version !== release.version || JSON.stringify(dashboard.source) !== JSON.stringify(release.source)) {
      throw new Error('Dashboard archive does not match the release source identity')
    }
    const captured = parseBannerJson(source, DASHBOARD_PREFIX, 'Windows-built Dashboard assets')
    if (!Array.isArray(captured) || JSON.stringify(captured.map((entry) => entry?.path).sort()) !== JSON.stringify(dashboard.files.map((file) => file.path).sort())) {
      throw new Error('Windows-built Dashboard inventory differs from the release archive')
    }
    const files = readExactTarGz(archive)
    const assets = dashboard.files.map((file) => ({ path: file.path, contentBase64: files.get(file.path).toString('base64') }))
    source = replaceBannerLine(source, DASHBOARD_PREFIX, `${DASHBOARD_PREFIX}${JSON.stringify(assets)};`)
  }

  const embedded = parseBannerJson(source, EMBEDDED_PREFIX, 'Portable Host embedded release assets')
  if (!Array.isArray(embedded)) throw new Error('Portable Host embedded release assets must be an array')

  const payloads = new Map()
  for (const item of embedded) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string' || typeof item.contentBase64 !== 'string') {
      throw new Error('Portable Host contains an invalid embedded release asset')
    }
    const name = item.path
    if (!SAFE_ASSET_NAME.test(name)) throw new Error(`Portable Host contains an unsafe embedded release asset name: ${name}`)
    if (name === PORTABLE_HOST_ASSET) throw new Error('Portable Host must not embed or checksum itself')
    if (name === 'SHA256SUMS') continue
    if (payloads.has(name)) throw new Error(`Portable Host contains duplicate embedded release asset: ${name}`)
    payloads.set(name, decodeBase64(item.contentBase64, name))
  }
  for (const name of WINDOWS_INSTALL_PAYLOADS) {
    payloads.set(name, name === installer ? installerBytes : readFileSync(join(releaseDir, name)))
  }

  const checksumIndex = [...payloads]
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}`)
    .join('\n') + '\n'
  const nextEmbedded = [...payloads].map(([path, bytes]) => ({ path, contentBase64: bytes.toString('base64') }))
  nextEmbedded.push({ path: 'SHA256SUMS', contentBase64: Buffer.from(checksumIndex).toString('base64') })

  const replacement = `${EMBEDDED_PREFIX}${JSON.stringify(nextEmbedded)};`
  const rewritten = replaceBannerLine(source, EMBEDDED_PREFIX, replacement)
  writeFileSync(join(releaseDir, installer), installerBytes)
  const temporaryPath = `${hostPath}.windows-assets-${process.pid}.tmp`
  writeFileSync(temporaryPath, rewritten, { mode })
  renameSync(temporaryPath, hostPath)
  chmodSync(hostPath, mode)

  return { hostPath, payloadNames: [...payloads.keys()], checksumIndex }
}

function assertReleaseIdentity(releaseDir, { repo, tag, expectedRevision }) {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repo)) throw new Error('release repo must be owner/name')
  if (!tag || /\s/u.test(tag)) throw new Error('release tag is required')
  if (!/^[0-9a-f]{40}$/u.test(expectedRevision)) throw new Error('expected release revision must be a full lowercase Git SHA')
  const manifest = JSON.parse(readFileSync(join(releaseDir, 'manifest.json'), 'utf8'))
  if (manifest.repo !== repo) throw new Error(`release manifest repo mismatch: expected ${repo}`)
  if (manifest.tag !== tag) throw new Error(`release manifest tag mismatch: expected ${tag}`)
  if (manifest.source?.revision !== expectedRevision) throw new Error('release manifest source revision mismatch')
  if (!Array.isArray(manifest.assets) || !manifest.assets.includes(PORTABLE_HOST_ASSET)) {
    throw new Error('release manifest does not contain the Portable Host')
  }
}

function parseBannerJson(source, prefix, label) {
  const lines = source.split('\n').filter((line) => line.startsWith(prefix))
  if (lines.length !== 1) throw new Error(`${label} assignment must appear exactly once`)
  const encoded = lines[0].slice(prefix.length)
  if (!encoded.endsWith(';')) throw new Error(`${label} assignment is malformed`)
  try { return JSON.parse(encoded.slice(0, -1)) } catch { throw new Error(`${label} assignment is not valid JSON`) }
}

function replaceBannerLine(source, prefix, replacement) {
  let count = 0
  const rewritten = source.split('\n').map((line) => {
    if (!line.startsWith(prefix)) return line
    count += 1
    return replacement
  }).join('\n')
  if (count !== 1) throw new Error('Portable Host embedded release assets assignment must appear exactly once')
  return rewritten
}

function decodeBase64(value, name) {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error(`Portable Host contains invalid base64 for embedded asset: ${name}`)
  return bytes
}

function assertRegularFile(path, name) {
  try {
    if (statSync(path).isFile()) return
  } catch {}
  throw new Error(`missing required release asset: ${name}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function optionValue(args, name) {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1]
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  return inline?.slice(name.length + 1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const directory = optionValue(args, '--directory') ?? 'release'
  const repo = optionValue(args, '--repo') ?? process.env.GITHUB_REPOSITORY
  const tag = optionValue(args, '--tag') ?? process.env.GITHUB_REF_NAME
  const expectedRevision = optionValue(args, '--expected-revision') ?? process.env.GITHUB_SHA
  if (!repo || !tag || !expectedRevision) throw new Error('--repo, --tag, and --expected-revision are required')
  const result = embedWindowsAssetsInPortableHost({ directory, repo, tag, expectedRevision, canonicalDashboard: args.includes('--canonical-dashboard') })
  console.log(`embedded ${result.payloadNames.length} payloads and a payload-only SHA256SUMS in ${basename(result.hostPath)}`)
}
