#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { verifyReleaseChecksums } from './release-checksums.mjs'
import { inspectDedicatedSupportBundle, DEDICATED_SUPPORT_ARCHIVE } from './dedicated-support-bundle.mjs'
import { dashboardArchiveName, releaseMetadataArchiveName, verifyDashboardArchive, verifyReleaseMetadataArchive } from './release-archives.mjs'
import { verifyWindowsNodePtyCompanion } from './windows-executor-packager.mjs'
import { verifyWindowsServiceHost, WINDOWS_SERVICE_HOST, windowsServiceHostManifestMetadata } from './windows-service-host.mjs'
import { POSIX_PORTABLE_MANAGER, WINDOWS_PORTABLE_MANAGER } from './portable-manager.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const releaseDir = join(root, 'release')
const manifestPath = join(releaseDir, 'manifest.json')

if (!existsSync(manifestPath)) fail('missing release/manifest.json')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const supportedNativeTargets = ['linux-x64', 'darwin-x64', 'darwin-arm64', 'win32-x64']
const supportedCopilotRuntimeTargets = supportedNativeTargets
const privateCloudRuntime = process.argv.includes('--private-cloud-runtime')
if (privateCloudRuntime && (manifest.component !== 'all' || process.argv.includes('--require-signed') || process.platform !== 'linux' || process.arch !== 'x64')) {
  fail('Private Cloud runtime verification requires an unsigned Linux x64 all-component image stage')
}
if (!/^[0-9a-f]{40}$/u.test(manifest.source?.revision ?? '')
  || !/^[0-9a-f]{64}$/u.test(manifest.source?.snapshotSha256 ?? '')
  || typeof manifest.source?.dirty !== 'boolean') {
  fail('manifest.source must bind a revision, exact worktree snapshot SHA-256, and dirty flag')
}
if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
  fail('manifest.assets must be a non-empty array')
}
if (new Set(manifest.assets).size !== manifest.assets.length) {
  fail('manifest.assets must not contain duplicates')
}
for (const asset of manifest.assets) assertSupportedReleaseAssetName(asset, 'manifest')
const actualNativeTargets = Array.isArray(manifest.nativeTargets) ? [...manifest.nativeTargets].sort() : undefined
if (!actualNativeTargets
  || (privateCloudRuntime
    ? JSON.stringify(actualNativeTargets) !== JSON.stringify(['win32-x64'])
    : actualNativeTargets.length !== 0 && JSON.stringify(actualNativeTargets) !== JSON.stringify([...supportedNativeTargets].sort()))) {
  fail(privateCloudRuntime
    ? 'Private Cloud runtime manifest.nativeTargets must contain exactly Windows x64'
    : 'manifest.nativeTargets must be empty for a CJS-only stage or contain exactly the four supported Executor targets')
}
for (const [product, assets] of Object.entries(manifest.nativeAssets ?? {})) {
  if (!Array.isArray(assets)) fail(`manifest.nativeAssets.${product} must be an array`)
  for (const asset of assets) {
    assertSupportedReleaseAssetName(asset, `manifest.nativeAssets.${product}`)
    if (!supportedNativeTargets.some((target) => asset === nativeExecutorAssetName(target))) fail(`unsupported native asset target in ${asset}`)
  }
}
const targetsForInventory = actualNativeTargets.length === 0 ? [] : privateCloudRuntime ? ['win32-x64'] : supportedNativeTargets
const expectedWindowsServiceHost = targetsForInventory.includes('win32-x64') ? windowsServiceHostManifestMetadata() : undefined
if (JSON.stringify(manifest.windowsServiceHost) !== JSON.stringify(expectedWindowsServiceHost)) {
  fail('manifest.windowsServiceHost must identify the pinned WinSW source, license, size, and SHA-256')
}
const expectedNativeAssets = {
  'kala-host': [],
  'kala-runtime': [],
  'kala-executor': targetsForInventory.map(nativeExecutorAssetName),
  'kala-dedicated-ingress': [],
  'kala-dedicated-deploy-supervisor': [],
}
if (JSON.stringify(manifest.nativeAssets) !== JSON.stringify(expectedNativeAssets)) {
  fail('manifest.nativeAssets must contain only the required native Executor assets')
}
const actualCopilotRuntimeTargets = Array.isArray(manifest.copilotRuntimeTargets)
  ? [...manifest.copilotRuntimeTargets].sort()
  : undefined
const expectedCopilotRuntimeTargets = privateCloudRuntime || actualNativeTargets.length === 0
  ? [`${process.platform}-${process.arch}`]
  : supportedCopilotRuntimeTargets
if (!actualCopilotRuntimeTargets
  || JSON.stringify(actualCopilotRuntimeTargets) !== JSON.stringify([...expectedCopilotRuntimeTargets].sort())) {
  fail('manifest.copilotRuntimeTargets must contain the build platform for a CJS stage or all supported release targets')
}
const copilotRuntimeAssets = actualCopilotRuntimeTargets.flatMap((target) => [
  `kala-copilot-runtime-${target}`,
  `kala-copilot-runtime-node-${target}.node`,
])
const expectedManifestAssets = [
  ...expectedNativeAssets['kala-executor'],
  ...copilotRuntimeAssets,
  ...(targetsForInventory.includes('win32-x64') ? ['node-pty-win32-x64.tar.gz', WINDOWS_SERVICE_HOST.asset, 'install-executor.ps1'] : []),
  'kala-dashboard-with-runtime.cjs',
  'kala-runtime.cjs',
  'kala-executor.cjs',
  'kala-dedicated-ingress.cjs',
  'kala-dedicated-deploy-supervisor.cjs',
  dashboardArchiveName,
  'kala-docs.tar.gz',
  DEDICATED_SUPPORT_ARCHIVE,
  releaseMetadataArchiveName,
  'run.sh',
  POSIX_PORTABLE_MANAGER,
  WINDOWS_PORTABLE_MANAGER,
  'kala-dedicated.mjs',
  'kala-model-catalog-seed.json',
].sort()
if (manifest.component === 'all' && JSON.stringify([...manifest.assets].sort()) !== JSON.stringify(expectedManifestAssets)) {
  fail(`manifest assets do not match the ${targetsForInventory.length ? 'final' : 'CJS-stage'} release contract`)
}
let metadata
try { metadata = verifyReleaseMetadataArchive(join(releaseDir, releaseMetadataArchiveName), { version: manifest.version }) } catch (error) { fail(error.message) }
const sbom = JSON.parse(metadata.get('sbom.cdx.json'))
const notices = metadata.get('THIRD_PARTY_NOTICES.txt').toString('utf8')
const notes = metadata.get('RELEASE_NOTES.md').toString('utf8')
const copilotDependency = sbom.components.find((component) => component.name === '@github/copilot-sdk')
const copilotRuntimeDependency = sbom.components.find((component) => component.name === `@github/copilot-sdk-${process.platform}-${process.arch}`)
if (!copilotDependency || !copilotRuntimeDependency || !notices.includes('@github/copilot-sdk@')) {
  fail('release metadata must retain the upstream Copilot SDK and platform runtime dependencies')
}
if (targetsForInventory.includes('win32-x64')) {
  const serviceHostDependency = sbom.components.find((component) => component.name === WINDOWS_SERVICE_HOST.product && component.version === WINDOWS_SERVICE_HOST.version)
  if (!serviceHostDependency
    || serviceHostDependency.licenses?.[0]?.license?.id !== WINDOWS_SERVICE_HOST.license
    || serviceHostDependency.hashes?.[0]?.content !== WINDOWS_SERVICE_HOST.sha256
    || !notices.includes(`${WINDOWS_SERVICE_HOST.product}@${WINDOWS_SERVICE_HOST.version} — ${WINDOWS_SERVICE_HOST.license}`)
    || !notices.includes(readFileSync(join(root, 'scripts/release/licenses/WinSW-MIT.txt'), 'utf8').trimEnd())) {
    fail('release metadata must retain the pinned WinSW source, digest, and complete MIT license')
  }
}
const signaturePresent = existsSync(join(releaseDir, 'SHA256SUMS.sigstore.json'))
if (privateCloudRuntime && signaturePresent) fail('Private Cloud runtime image stage must not contain a signature bundle')
if (process.argv.includes('--require-signed') && (!signaturePresent || actualNativeTargets.length !== supportedNativeTargets.length)) {
  fail('signed final release requires the signature bundle and all four native Executor targets')
}
const expectedReleaseFiles = [...manifest.assets, 'manifest.json', 'SHA256SUMS', ...(signaturePresent ? ['SHA256SUMS.sigstore.json'] : [])].sort()
const actualReleaseEntries = readdirSync(releaseDir, { withFileTypes: true })
for (const entry of actualReleaseEntries) assertSupportedReleaseAssetName(entry.name, 'release directory')
if (actualReleaseEntries.some((entry) => !entry.isFile())
  || JSON.stringify(actualReleaseEntries.map((entry) => entry.name).sort()) !== JSON.stringify(expectedReleaseFiles)) {
  fail('release file set does not exactly match its manifest')
}
const includesHost = manifest.component === 'all' || manifest.component === 'host'
if (includesHost) {
  for (const asset of [POSIX_PORTABLE_MANAGER, WINDOWS_PORTABLE_MANAGER]) {
    if (!manifest.assets.includes(asset)) fail(`manifest missing Portable manager asset ${asset}`)
  }
  for (const asset of [
    'kala-dedicated-ingress.cjs',
    'kala-runtime.cjs',
    'kala-dedicated-deploy-supervisor.cjs',
    'kala-dedicated.mjs',
    DEDICATED_SUPPORT_ARCHIVE,
  ]) {
    if (!manifest.assets.includes(asset)) fail(`manifest missing Dedicated asset ${asset}`)
  }
  for (const asset of copilotRuntimeAssets) {
    if (!manifest.assets.includes(asset)) fail(`manifest missing Copilot runtime asset ${asset}`)
    accessSync(join(releaseDir, asset), constants.R_OK)
  }
  try { inspectDedicatedSupportBundle(join(releaseDir, DEDICATED_SUPPORT_ARCHIVE)) } catch (error) { fail(error.message) }
  const hostBundle = readFileSync(join(releaseDir, 'kala-dashboard-with-runtime.cjs'), 'utf8')
  const buildInfoLine = hostBundle.split('\n', 3)[1]
  if (!buildInfoLine?.startsWith('globalThis.__KALA_BUILD_INFO__=')) fail('Portable Host CJS is missing release build metadata')
  let hostBuildInfo
  try { hostBuildInfo = JSON.parse(buildInfoLine.slice('globalThis.__KALA_BUILD_INFO__='.length).replace(/;$/u, '')) } catch { fail('Portable Host CJS build metadata is invalid') }
  if (hostBuildInfo.gitCommit !== manifest.source.revision.slice(0, 12)
    || hostBuildInfo.sourceSnapshotSha256 !== manifest.source.snapshotSha256
    || hostBuildInfo.productVersion !== manifest.version
    || hostBuildInfo.releaseTag !== manifest.tag
    || hostBuildInfo.artifactKind !== 'cjs'
    || hostBuildInfo.dashboardMode !== 'embedded') fail('Portable Host CJS differs from the signed manifest source/tag identity')
  const embeddedAssetsPrefix = 'globalThis.__KALA_EMBEDDED_RELEASE_ASSETS__='
  const embeddedAssetsStart = hostBundle.indexOf(embeddedAssetsPrefix)
  if (embeddedAssetsStart < 0) fail('release Host bundle is missing embedded release assets')
  const embeddedAssetsEnd = hostBundle.indexOf(';\n', embeddedAssetsStart + embeddedAssetsPrefix.length)
  if (embeddedAssetsEnd < 0) fail('release Host bundle has unterminated embedded release assets')
  // The banner may contain hundreds of MB of base64. V8 regular expressions
  // over that whole line overflow the call stack; locate its terminator instead.
  const embeddedAssets = JSON.parse(hostBundle.slice(embeddedAssetsStart + embeddedAssetsPrefix.length, embeddedAssetsEnd))
  for (const asset of embeddedAssets) assertSupportedReleaseAssetName(asset?.path, 'embedded Host assets')
  if (!embeddedAssets.some((asset) => asset.path === 'run.sh')) fail('release Host bundle must embed run.sh')
  const windowsInstallAssets = ['kala-executor-win32-x64.exe', 'kala-executor-service-host-win32-x64.exe', 'node-pty-win32-x64.tar.gz', 'install-executor.ps1']
  if (windowsInstallAssets.every((name) => manifest.assets.includes(name))) {
    const embeddedByName = new Map()
    for (const asset of embeddedAssets) {
      if (embeddedByName.has(asset.path)) fail(`Portable Host has duplicate embedded asset ${asset.path}`)
      let bytes
      try { bytes = Buffer.from(asset.contentBase64, 'base64') } catch { fail(`Portable Host has invalid base64 for ${asset.path}`) }
      if (bytes.toString('base64') !== asset.contentBase64) fail(`Portable Host has non-canonical base64 for ${asset.path}`)
      embeddedByName.set(asset.path, bytes)
    }
    const embeddedIndex = embeddedByName.get('SHA256SUMS')?.toString('utf8')
    if (!embeddedIndex) fail('Portable Host with Windows assets must embed SHA256SUMS')
    const expected = new Map()
    for (const line of embeddedIndex.split(/\r?\n/u).filter(Boolean)) {
      const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u)
      if (!match || expected.has(match[2])) fail('Portable Host embedded SHA256SUMS is malformed or contains duplicates')
      expected.set(match[2], match[1])
    }
    if (expected.has('kala-dashboard-with-runtime.cjs') || expected.has('SHA256SUMS')) fail('Portable Host embedded SHA256SUMS must be payload-only')
    for (const name of windowsInstallAssets) {
      const bytes = embeddedByName.get(name)
      if (!bytes || !bytes.equals(readFileSync(join(releaseDir, name)))) fail(`Portable Host does not embed the final ${name}`)
      if (expected.get(name) !== createHash('sha256').update(bytes).digest('hex')) fail(`Portable Host embedded SHA256SUMS does not authenticate ${name}`)
    }
  }
  if (!hostBundle.includes('__KALA_EMBEDDED_DOCS__')
    || !hostBundle.includes(Buffer.from('# Dedicated Platform Runtime Unit Refactor').toString('base64'))) {
    fail('release Host bundle is missing embedded product documentation')
  }
  const platformRuntime = readFileSync(join(releaseDir, 'kala-runtime.cjs'), 'utf8')
  if (platformRuntime.includes('globalThis.__KALA_EMBEDDED_DASHBOARD__=')) fail('Self-hosted Platform Runtime must not embed Dashboard assets')
  try {
    const dashboard = verifyDashboardArchive(join(releaseDir, dashboardArchiveName)).manifest
    if (dashboard.version !== manifest.version || JSON.stringify(dashboard.source) !== JSON.stringify(manifest.source)) {
      fail('Dashboard archive version or source identity does not match the release manifest')
    }
  } catch (error) { fail(error.message) }
  const operatorHelp = spawnSync('node', ['kala-dedicated.mjs', '--help'], { cwd: releaseDir, encoding: 'utf8' })
  if (operatorHelp.status !== 0 || !['install', 'status', 'upgrade', 'rollback', 'backup', 'restore', 'uninstall'].every((command) => operatorHelp.stdout.includes(command))) fail('Dedicated operator CLI help is incomplete')
  accessSync(join(releaseDir, 'kala-dedicated.mjs'), constants.X_OK)
}

const forbiddenLegacyEvaluationMarkers = [
  'src/eval/',
  'run-benchmark-web',
  'run-programbench-legacy-runner',
  'run-browsecomp-legacy-runner',
  'run-jobbench-legacy-runner',
]

for (const asset of manifest.assets) {
  const path = join(releaseDir, asset)
  if (!existsSync(path)) fail(`missing asset ${asset}`)
  if (asset.endsWith('.cjs')) {
    const text = readFileSync(path, 'utf8')
    if (!text.startsWith('#!/usr/bin/env node\n')) {
      fail(`${asset} is missing node shebang`)
    }
    for (const marker of forbiddenLegacyEvaluationMarkers) {
      if (text.includes(marker)) fail(`${asset} contains legacy evaluation content: ${marker}`)
    }
    accessSync(path, constants.X_OK)
  }
  if (isNativeAsset(asset)) {
    accessSync(path, constants.X_OK)
  }
  if (asset === POSIX_PORTABLE_MANAGER) {
    const text = readFileSync(path, 'utf8')
    accessSync(path, constants.X_OK)
    if (!text.startsWith('#!/usr/bin/env bash\n') || !text.includes('KALA_BIND_HOST="$bind"') || !text.includes('cosign verify-blob') || !text.includes('--purge-data')) {
      fail(`${asset} is missing the verified lifecycle, loopback bind, or retention contract`)
    }
    const syntax = spawnSync('bash', ['-n', path], { stdio: 'inherit' })
    if (syntax.status !== 0) fail(`${asset} failed bash syntax check`)
  }
  if (asset === WINDOWS_PORTABLE_MANAGER) {
    const text = readFileSync(path, 'utf8')
    if (!text.startsWith('#requires -Version 5.1\n') || !text.includes("'127.0.0.1'") || !text.includes('cosign verify-blob') || !text.includes('not a Windows Service installer')) {
      fail(`${asset} is missing the verified lifecycle, loopback bind, or Windows service distinction`)
    }
  }
  if (asset === 'run.sh') {
    const text = readFileSync(path, 'utf8')
    if (!text.startsWith('#!/usr/bin/env bash\n')) {
      fail(`${asset} is missing bash shebang`)
    }
    accessSync(path, constants.X_OK)
    if (text.includes('curl')) fail(`${asset} must be wget-only and must not mention curl`)
    if (text.includes('copilot-cli') || text.includes('COPILOT_CLI_PATH')) fail(`${asset} must not download a standalone Copilot CLI`)
    if (!text.includes('Release downloads require HTTPS except for loopback URLs') || !text.includes('cosign verify-blob')) fail(`${asset} must reject public unsigned installs`)
    if (!text.includes('KALA_RELEASE_TRUST') || !text.includes('Host-mediated release trust requires a valid internal installation session') || !text.includes('"$BASE_URL" != "$host_asset_base"')) {
      fail(`${asset} must narrowly bind Host-mediated trust to an internal installation session`)
    }
    if (/wget\s+-qO-.*\|.*bash/.test(text)) {
      fail(`${asset} must not suggest quiet wget pipe-to-bash bootstrap commands`)
    }
    if (!text.includes('wget -nv -O')) {
      fail(`${asset} user-facing examples must use diagnostic temp-file bootstrap commands`)
    }
    if (!text.includes('KALA_RUNTIME:-auto')) {
      fail(`${asset} must support KALA_RUNTIME=auto|cjs|native`)
    }
    if (!text.includes('[ "$runtime" = "auto" ] && has_node22')) {
      fail(`${asset} must prefer compact .cjs assets when Node.js 22+ is available`)
    }
    if (!text.includes('Kala bootstrap | %s')) {
      fail(`${asset} must use the compact bootstrap log prefix`)
    }
    if (!text.includes('wget -q --tries=3 --timeout=30 --retry-connrefused')) {
      fail(`${asset} must keep wget output compact`)
    }
    if (text.includes('--show-progress') || text.includes('--progress=')) {
      fail(`${asset} must not print wget progress output by default`)
    }
    if (text.includes('Downloading ${name} from ${url}')) {
      fail(`${asset} must not print verbose download source lines by default`)
    }
    const syntax = spawnSync('bash', ['-n', path], { stdio: 'inherit' })
    if (syntax.status !== 0) fail(`${asset} failed bash syntax check`)
    const badComponent = spawnSync('bash', ['-c', 'COMPONENT=bad bash release/run.sh'], {
      cwd: root,
      encoding: 'utf8',
    })
    if (badComponent.status === 0) fail(`${asset} unknown component smoke test should fail`)
    const badComponentOutput = `${badComponent.stdout}\n${badComponent.stderr}`
    if (!badComponentOutput.includes('Unknown COMPONENT') || !badComponentOutput.includes('wget -nv -O "$tmp"') || !badComponentOutput.includes('HOST_URL=http://127.0.0.1:3000 COMPONENT=executor')) {
      fail(`${asset} unknown component smoke test did not print diagnostic usage`)
    }
    if (badComponentOutput.includes('unbound variable')) {
      fail(`${asset} unknown component usage must not expand example shell variables`)
    }
    const missingHost = spawnSync('bash', ['-c', 'COMPONENT=executor bash release/run.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOST_URL: '' },
    })
    if (missingHost.status === 0) fail(`${asset} executor missing HOST_URL smoke test should fail`)
    const missingHostOutput = `${missingHost.stdout}\n${missingHost.stderr}`
    if (!missingHostOutput.includes('requires HOST_URL') || !missingHostOutput.includes('wget -nv -O "$tmp"') || !missingHostOutput.includes('HOST_URL=http://127.0.0.1:3000 COMPONENT=executor')) {
      fail(`${asset} executor missing HOST_URL smoke test did not print diagnostic usage`)
    }
    if (missingHostOutput.includes('download SHA256SUMS') || missingHostOutput.includes('unbound variable')) {
      fail(`${asset} executor missing HOST_URL must fail before downloads and must not expand example shell variables`)
    }
  }
}

for (const forbidden of ['install-executor.sh', 'COPILOT_CLI_LICENSE.md']) {
  if (manifest.assets.includes(forbidden) || existsSync(join(releaseDir, forbidden))) fail(`release must not publish ${forbidden}`)
}
if (manifest.assets.some((asset) => asset === 'copilot-cli' || asset.startsWith('copilot-cli-'))) fail('release must not publish standalone Copilot CLI assets')
if (manifest.assets.includes('run.sh') && (!notes.includes("set -o pipefail; curl --proto '=https' --tlsv1.2 -fsSL") || !notes.includes('| COMPONENT='))) {
  fail('release notes missing direct HTTPS curl-to-bash bootstrap with pipefail')
}
for (const section of ['## Improvements', '## Fixes', '## Known issues', '## Installation', '## Supported platforms', '## Verification', '## Full changelog']) {
  if (!notes.includes(section)) fail(`release notes missing ${section.slice(3)} section`)
}
if (notes.includes('## Highlights')) {
  fail('release notes must use objective Improvements and Fixes sections instead of Highlights')
}
if (notes.includes('## Assets')) {
  fail('release notes must not duplicate the GitHub release assets list')
}
if (/bash -c 'set -euo pipefail; tmp=\$\(mktemp\)/.test(notes)) {
  fail('release notes must not wrap bootstrap commands in bash -c temp-file snippets')
}
if (notes.includes('chmod +x run.sh') || notes.includes('./run.sh')) {
  fail('release notes must not require saving run.sh before execution')
}
if (/wget\s+-qO-.*\|.*bash/.test(notes)) {
  fail('release notes must not pipe quiet wget output directly into bash')
}
if (notes.includes('run-host.sh') || notes.includes('run-executor.sh')) {
  fail('release notes must use unified run.sh only')
}
if (!notes.includes('grep "  $ASSET$" SHA256SUMS | sha256sum -c -') || !notes.includes('cosign verify-blob')) {
  fail('release notes missing focused checksum or Sigstore verification commands')
}
if ((notes.match(/\bwget\b/g) ?? []).length > 1) {
  fail('release notes must not duplicate per-asset wget commands')
}
if (/kala-(?:dashboard-with-runtime|host|executor)\.cjs\s*\|\s*node/.test(notes)) {
  fail('release notes must not pipe Node.js assets directly to node')
}
if (!notes.includes('Linux x64, macOS x64/arm64, and Windows x64') || !notes.includes('Linux arm64 and Windows arm64 release assets are not included')) {
  fail('release notes must state the exact four-target support scope')
}

try {
  await verifyReleaseChecksums(releaseDir, [...manifest.assets, 'manifest.json'])
} catch {
  fail('SHA256SUMS verification failed')
}
if (manifest.assets.includes('node-pty-win32-x64.tar.gz')) {
  try {
    verifyWindowsNodePtyCompanion(join(releaseDir, 'node-pty-win32-x64.tar.gz'))
  } catch (error) {
    fail(`Windows node-pty companion verification failed: ${error.message}`)
  }
}
if (manifest.assets.includes(WINDOWS_SERVICE_HOST.asset)) {
  try {
    verifyWindowsServiceHost(join(releaseDir, WINDOWS_SERVICE_HOST.asset))
  } catch (error) {
    fail(`Windows service host verification failed: ${error.message}`)
  }
}

if (manifest.assets.includes('kala-executor.cjs')) {
  const executorHelp = spawnSync('node', ['kala-executor.cjs', '--help'], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (executorHelp.status !== 0) fail('executor --help smoke test should exit 0')
  const helpOutput = `${executorHelp.stdout}\n${executorHelp.stderr}`
  if (!helpOutput.includes('Kala Executor') || !helpOutput.includes('Usage:') || !helpOutput.includes('kala-executor --host <url>') || !helpOutput.includes('--sandbox-root <path>') || !helpOutput.includes('service status|logs|start|stop|restart|uninstall')) {
    fail('executor --help smoke test did not print daemon and service lifecycle usage')
  }
  if (helpOutput.includes('connecting to')) {
    fail('executor --help must not connect to a host')
  }

  const executorVersion = spawnSync('node', ['kala-executor.cjs', '--version'], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (executorVersion.status !== 0) fail('executor --version smoke test should exit 0')
  const reportedVersion = executorVersion.stdout.match(/^Kala Executor (\S+)$/m)?.[1]
  if (!reportedVersion || reportedVersion !== manifest.version) {
    fail(`executor --version must equal the release product version ${manifest.version}`)
  }

  const executor = spawnSync('node', ['kala-executor.cjs'], {
    cwd: releaseDir,
    encoding: 'utf8',
    env: { ...process.env, HOST_URL: '' },
  })
  if (executor.status !== 1) fail('executor usage smoke test should exit 1')
  const output = `${executor.stdout}\n${executor.stderr}`
  if (!output.includes('missing host url') || !output.includes('"flag":"--host"') || !output.includes('"env":"HOST_URL"')) {
    fail('executor usage smoke test did not print usage')
  }
}

if (manifest.assets.includes('kala-dashboard-with-runtime.cjs')) {
  const hostHelp = spawnSync('node', ['kala-dashboard-with-runtime.cjs', '--help'], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (hostHelp.status !== 0) fail('host --help smoke test should exit 0')
  const output = `${hostHelp.stdout}\n${hostHelp.stderr}`
  if (!output.includes('Kala Runtime') || !output.includes('Usage:') || !output.includes('kala-dashboard-with-runtime.cjs [options]') || !output.includes('--port <port>')) {
    fail('host --help smoke test did not print CLI usage')
  }
  if (output.includes('host listening')) {
    fail('host --help must not start the server')
  }

  const hostVersion = spawnSync('node', ['kala-dashboard-with-runtime.cjs', '-v'], {
    cwd: releaseDir,
    encoding: 'utf8',
  })
  if (hostVersion.status !== 0) fail('host -v smoke test should exit 0')
  if (!/^Kala Runtime \d+\.\d+\.\d+/m.test(hostVersion.stdout)) {
    fail('host -v smoke test did not print version')
  }
}

const nativeExecutor = manifest.assets.find((asset) => asset === nativeAssetName('kala-executor'))
if (nativeExecutor) {
  const executor = spawnSync(`./${nativeExecutor}`, [], {
    cwd: releaseDir,
    encoding: 'utf8',
    env: { ...process.env, HOST_URL: '' },
  })
  if (executor.status !== 1) fail('native executor usage smoke test should exit 1')
  const output = `${executor.stdout}\n${executor.stderr}`
  if (!output.includes('missing host url') || !output.includes('"flag":"--host"') || !output.includes('"env":"HOST_URL"')) {
    fail('native executor usage smoke test did not print usage')
  }
}

console.log('release assets verified')

function isNativeAsset(asset) {
  return /^kala-(?:host|executor|dedicated-ingress|dedicated-deploy-supervisor)-(?:linux|darwin)-(?:x64|arm64)$/.test(asset)
    || asset === 'kala-executor-win32-x64.exe'
    || asset === WINDOWS_SERVICE_HOST.asset
}

function nativeExecutorAssetName(target) {
  return target === 'win32-x64' ? 'kala-executor-win32-x64.exe' : `kala-executor-${target}`
}

function nativeAssetName(base) {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : undefined
  return os && arch ? `${base}-${os}-${arch}` : undefined
}

function assertSupportedReleaseAssetName(name, location) {
  const acceptedWindows = new Set([
    'kala-executor-win32-x64.exe',
    'node-pty-win32-x64.tar.gz',
    WINDOWS_SERVICE_HOST.asset,
    'install-executor.ps1',
    'kala-copilot-runtime-win32-x64',
    'kala-copilot-runtime-node-win32-x64.node',
  ])
  if (typeof name !== 'string'
    || /linux-arm64/iu.test(name)
    || ((/(?:win32|windows|conpty)/iu.test(name) || /\.(?:exe|ps1)$/iu.test(name) || /^node-pty-.*\.tar\.gz$/iu.test(name)) && !acceptedWindows.has(name))
    || /^executor-update-(?:manifest\.json|public-key\.pem)$/u.test(name)) {
    fail(`${location} contains unsupported or platform-ambiguous release asset ${String(name)}`)
  }
}

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exit(1)
}
