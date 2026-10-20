#!/usr/bin/env node
import { copyFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { build } from 'esbuild'
import {
  executorNativeAssetName,
  generateExecutorInstallerPowerShell,
  windowsExecutorInstallerAssetName,
} from './executor-installer.mjs'
import { buildDedicatedSupportBundle, DEDICATED_SUPPORT_ARCHIVE } from './dedicated-support-bundle.mjs'
import {
  createDashboardArchive,
  createReleaseMetadataArchive,
  dashboardArchiveName,
  releaseMetadataArchiveName,
} from './release-archives.mjs'
import {
  packageWindowsNodePtyCompanion,
  WINDOWS_EXECUTOR_TARGET,
  windowsNodePtyCompanionAssetName,
} from './windows-executor-packager.mjs'
import {
  stageWindowsServiceHost,
  WINDOWS_SERVICE_HOST,
  windowsServiceHostManifestMetadata,
} from './windows-service-host.mjs'
import {
  generatePosixPortableManager,
  generateWindowsPortableManager,
  POSIX_PORTABLE_MANAGER,
  WINDOWS_PORTABLE_MANAGER,
} from './portable-manager.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const outDir = join(root, 'release')
const dashboardDist = join(root, 'packages/dashboard/dist')
const docsDir = join(root, 'docs')
const releaseNotesCatalog = JSON.parse(readFileSync(join(root, 'scripts', 'release', 'release-notes.json'), 'utf8'))
const modelCatalogSeed = join(root, 'resources', 'model-catalog', 'models-dev-seed.json')
const socketAdminDist = resolveSocketAdminDist()
const options = parseOptions(process.argv.slice(2))
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const sourceIdentity = readSourceIdentity()
const releaseBuiltAt = deterministicBuildTime()
const { component, tag, nativeOnly, finalizeOnly, noNative, skipDashboardBuild, skipPackageBuild } = options
const repo = options.repo ?? repoFromPackageJson(packageJson)
if (!repo && component !== 'dashboard') {
  throw new Error('release repo is required; pass --repo owner/name or set GITHUB_REPOSITORY')
}
if (nativeOnly && noNative) throw new Error('--native-only and --no-native are mutually exclusive')
// Self-contained SEA executables are opt-in. The release workflow invokes
// --component executor --native-only explicitly for its required OS targets.
const wantsNativeBuild = !finalizeOnly && nativeOnly
const currentNativeTarget = wantsNativeBuild ? detectNativeTarget() : undefined
const nativeTarget = wantsNativeBuild ? options.nativeTarget ?? currentNativeTarget : undefined

if (!finalizeOnly) rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const allEntries = [
  {
    name: 'kala-host',
    cjsName: 'kala-dashboard-with-runtime',
    role: 'host',
    component: 'host',
    entry: join(root, 'packages/host/bin/kala-host.ts'),
  },
  {
    name: 'kala-runtime',
    role: 'runtime',
    component: 'host',
    entry: join(root, 'packages/host/bin/kala-host.ts'),
    platformOnly: true,
  },
  {
    name: 'kala-executor',
    role: 'executor',
    component: 'executor',
    entry: join(root, 'packages/executor/bin/kala-executor.ts'),
  },
  {
    name: 'kala-dedicated-ingress',
    role: 'dedicated-ingress',
    component: 'host',
    entry: join(root, 'packages/host/bin/kala-dedicated-ingress.ts'),
  },
  {
    name: 'kala-dedicated-deploy-supervisor',
    role: 'dedicated-deploy-supervisor',
    component: 'host',
    entry: join(root, 'packages/host/bin/kala-dedicated-deploy-supervisor.ts'),
  },
]
const entries = allEntries.filter((entry) => component === 'all' || entry.component === component)
const includeDashboard = component === 'all' || component === 'host' || component === 'dashboard'
const nativeTargets = ['linux-x64', 'darwin-x64', 'darwin-arm64', WINDOWS_EXECUTOR_TARGET]
const supportedNativeBuildTargets = nativeTargets
// Portable Host CJS is platform-neutral, but each supported OS must contribute
// its adjacent Copilot SDK wrapper and native runtime from a matching runner.
const copilotRuntimeTargets = nativeTargets
if (finalizeOnly) {
  finalizeRelease()
  process.exit(0)
}

if (wantsNativeBuild && nativeTarget !== currentNativeTarget) {
  throw new Error(`native target ${nativeTarget} does not match this runner (${currentNativeTarget}); Node SEA builds are not cross-compiled`)
}
if (wantsNativeBuild && nativeTarget === WINDOWS_EXECUTOR_TARGET && component !== 'executor') {
  throw new Error('Windows native release builds are Executor-only; Portable Host remains a Node.js 22+ CJS asset')
}

if (!nativeOnly && !skipPackageBuild) {
  await run('pnpm', ['--filter', '@agent-kernel/kernel', 'build'])
  await run('pnpm', ['--filter', '@agent-kernel/shared', 'build'])
  await run('pnpm', ['--filter', '@agent-kernel/executor', 'build'])
  await run('pnpm', ['--filter', '@agent-kernel/host', 'build'])
}
const { PROTOCOL_VERSION } = await import(pathToFileURL(join(root, 'packages/shared/dist/index.js')).href)
if (typeof PROTOCOL_VERSION !== 'string' || !/^\d+\.\d+\.\d+$/u.test(PROTOCOL_VERSION)) {
  throw new Error('shared protocol version is unavailable or invalid')
}

// Dashboard imports generated declarations from kernel/shared. Build those
// packages first or a clean production build can typecheck against stale dist.
if (includeDashboard && !skipDashboardBuild) {
  await run('pnpm', ['--filter', '@agent-kernel/dashboard', 'build'])
}
if (includeDashboard && skipDashboardBuild) {
  assertDashboardDistReady(dashboardDist)
}
if (component === 'all' || component === 'host') {
  stageCopilotRuntime(nativeTarget ?? detectNativeTarget())
}

// The host bundle is built before finalizeRelease(), so every asset that must be
// served from an embedded-only deployment has to exist before the host banner is
// generated. Keep this in front of buildEntries; moving it back below the host
// build silently produces a valid bundle with broken /install/assets URLs.
prepareBootstrapAssets()

const buildEntries = [...entries].sort((a, b) => {
  if (a.component === 'host' && b.component !== 'host') return 1
  if (b.component === 'host' && a.component !== 'host') return -1
  return 0
})

for (const item of buildEntries) {
  const embedsHostRuntime = item.role === 'host' || item.role === 'runtime'
  const embedsDashboard = item.role === 'host' && includeDashboard
  const embeddedReleaseAssets = embedsHostRuntime
    ? prepareEmbeddedReleaseAssetsForHost()
    : ''
  const embeddedDashboard = embedsDashboard
    ? embeddedDashboardBanner(dashboardDist)
    : ''
  const embeddedDocs = embedsHostRuntime && includeDashboard
    ? embeddedDocsBanner(docsDir)
    : ''
  const embeddedSocketAdmin = embedsHostRuntime
    ? embeddedSocketAdminBanner(socketAdminDist)
    : ''
  const buildInfo = buildInfoBanner({ artifactKind: nativeOnly ? 'native' : 'cjs', dashboardMode: embedsDashboard ? 'embedded' : 'none', socketAdminMode: embedsHostRuntime ? 'embedded' : 'missing' })
  // SEA's injected-main require only resolves built-ins. node-pty loads its native
  // companion at spawn time, so the Executor must resolve beside its executable.
  const nativeRequire = wantsNativeBuild && item.role === 'executor'
    ? "require = require('node:module').createRequire(__filename);\n"
    : ''
  const outfile = nativeOnly
    ? join(outDir, '.sea', `${item.name}-${nativeTarget}`, `${item.name}.cjs`)
    : join(outDir, cjsAssetName(item))
  mkdirSync(dirname(outfile), { recursive: true })
  await build({
    entryPoints: [item.entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    mainFields: ['module', 'main'],
    banner: { js: `#!/usr/bin/env node\n${nativeRequire}${buildInfo}${embeddedDashboard}${embeddedDocs}${embeddedSocketAdmin}${embeddedReleaseAssets}` },
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  })
  const bundled = readFileSync(outfile, 'utf8')
  writeFileSync(outfile, keepSingleShebang(bundled))
  if (!nativeOnly) chmodSync(outfile, 0o755)
  if (!item.platformOnly && nativeOnly) {
    await buildNativeSea(item.name, outfile, nativeTarget)
  }
}

// Host CJS still needs the platform Copilot SDK runtime files for agent turns.
// Stage those dependencies without building a self-contained native Host.
if (nativeOnly && component === 'executor' && copilotRuntimeTargets.includes(nativeTarget)) {
  stageCopilotRuntime(nativeTarget)
}

if (nativeOnly && nativeTarget === WINDOWS_EXECUTOR_TARGET && entries.some((entry) => entry.role === 'executor')) {
  const executorRequire = createRequire(join(root, 'packages/executor/package.json'))
  const nodePtyRoot = dirname(executorRequire.resolve('node-pty/package.json'))
  packageWindowsNodePtyCompanion({
    nodePtyRoot,
    outputPath: join(outDir, windowsNodePtyCompanionAssetName(nativeTarget)),
    target: nativeTarget,
  })
  await stageWindowsServiceHost(join(outDir, WINDOWS_SERVICE_HOST.asset))
}

if (nativeOnly) {
  removeNativeBuildWorkspace()
  console.log(`native release assets written to ${outDir} for ${nativeTarget}`)
  for (const item of entries) console.log(` - ${basename(nativeAssetName(item.name, nativeTarget))}`)
  if (nativeTarget === WINDOWS_EXECUTOR_TARGET && entries.some((entry) => entry.role === 'executor')) {
    console.log(` - ${windowsNodePtyCompanionAssetName(nativeTarget)}`)
    console.log(` - ${WINDOWS_SERVICE_HOST.asset}`)
  }
  if (copilotRuntimeTargets.includes(nativeTarget)) {
    for (const asset of copilotRuntimeAssetNames(nativeTarget)) console.log(` - ${asset}`)
  }
  process.exit(0)
}

if (includeDashboard) {
  writeDashboardReleaseManifest(dashboardDist)
  createDashboardArchive({
    dashboardDist,
    manifestPath: join(outDir, 'dashboard-release.json'),
    outputPath: join(outDir, dashboardArchiveName),
  })
  // Never package untracked local docs (captures, screenshots, notes). The
  // tracked showcase GIF is still unfinished and explicitly excluded.
  // CI supplies Git's tracked-docs list before creating a gitless Docker context.
  // Never fall back to walking docs/: local screenshots and notes are not release assets.
  const docsListPath = join(docsDir, '.tracked-release-docs')
  let listedDocs
  if (existsSync(join(root, '.git'))) {
    const result = spawnSync('git', ['ls-files', '-z', '--', 'docs/'], { cwd: root, encoding: 'buffer' })
    if (result.status !== 0) throw new Error('cannot enumerate tracked release docs')
    listedDocs = result.stdout
  } else {
    if (!existsSync(docsListPath)) throw new Error('gitless release build requires a tracked docs list')
    listedDocs = readFileSync(docsListPath)
  }
  const docsFiles = listedDocs.toString('utf8').split('\0')
    .filter((file) => file.startsWith('docs/') && !file.split('/').includes('..') && file !== 'docs/assets/kala-dashboard-preview.gif')
    .map((file) => file.slice('docs/'.length))
    .filter(Boolean)
  const docsArchive = spawnSync('tar', ['-czf', join(outDir, 'kala-docs.tar.gz'), '-C', docsDir, '--null', '-T', '-'], {
    input: Buffer.from(`${docsFiles.join('\0')}\0`),
    encoding: 'utf8',
  })
  if (docsArchive.status !== 0) throw new Error(`cannot package tracked release docs: ${docsArchive.stderr}`)
}

finalizeRelease()

console.log(`release assets written to ${outDir}`)
for (const file of [...releaseFiles(), 'SHA256SUMS']) {
  console.log(` - ${basename(file)}`)
}

function finalizeRelease() {
  assertSourceIdentityUnchanged()
  assertStagedSourceIdentity()
  removeNativeBuildWorkspace()
  const bootstrapAssets = prepareBootstrapAssets()
  if (includeDashboard && existsSync(modelCatalogSeed)) {
    copyFileSync(modelCatalogSeed, join(outDir, 'kala-model-catalog-seed.json'))
  }
  if (component !== 'dashboard') {
    if (component === 'all' || component === 'host') {
      copyFileSync(join(root, 'scripts/deploy/kala-dedicated.mjs'), join(outDir, 'kala-dedicated.mjs'))
      chmodSync(join(outDir, 'kala-dedicated.mjs'), 0o755)
      bootstrapAssets.push('kala-dedicated.mjs')
      buildDedicatedSupportBundle({ root, output: join(outDir, DEDICATED_SUPPORT_ARCHIVE) })
    }
  }

  // Desktop payloads are embedded into the Host banner only; they are not
  // independent public release assets.
  for (const name of ['desktop-install.sh', 'desktop-package.deb', 'desktop-dependencies.json', 'desktop-SHA256SUMS.txt']) rmSync(join(outDir, name), { force: true })

  const builtEntries = entries.map((entry) => {
    const cjs = cjsAssetName(entry)
    const natives = nativeTargets
      .map((target) => nativeAssetName(entry.name, target))
      .filter((asset) => exists(asset))
    return { ...entry, cjs: exists(cjs) ? cjs : undefined, natives }
  })
  const packagedCopilotRuntimeTargets = copilotRuntimeTargets
    .filter((target) => copilotRuntimeAssetNames(target).every((asset) => exists(asset)))
  writeDependencyMetadata()
  const assets = builtEntries.flatMap((entry) => [entry.cjs, ...entry.natives].filter(Boolean))
    .concat(packagedCopilotRuntimeTargets.flatMap(copilotRuntimeAssetNames))
    .concat(includeDashboard && exists(dashboardArchiveName) ? [dashboardArchiveName] : [])
    .concat(includeDashboard && exists('kala-docs.tar.gz') ? ['kala-docs.tar.gz'] : [])
    .concat((component === 'all' || component === 'host') && exists(DEDICATED_SUPPORT_ARCHIVE) ? [DEDICATED_SUPPORT_ARCHIVE] : [])
    .concat(includeDashboard && exists('kala-model-catalog-seed.json') ? ['kala-model-catalog-seed.json'] : [])
    .concat(bootstrapAssets)
  const hasNativeAssets = builtEntries.some((entry) => entry.natives.length > 0)
  const manifest = {
    name: 'kala',
    version: packageJson.version,
    source: sourceIdentity,
    component,
    repo: repo ?? '',
    tag,
    node: '>=22',
    nativeTargets: nativeTargets.filter((target) => builtEntries.some((entry) => entry.natives.includes(nativeAssetName(entry.name, target)))),
    copilotRuntimeTargets: packagedCopilotRuntimeTargets,
    windowsServiceHost: exists(WINDOWS_SERVICE_HOST.asset) ? windowsServiceHostManifestMetadata() : undefined,
    assets,
    nativeAssets: {
      ...Object.fromEntries(builtEntries.map((entry) => [entry.name, entry.natives])),
    },
    fallbackAssets: Object.fromEntries(builtEntries.map((entry) => [entry.name, entry.cjs]).filter(([, cjs]) => cjs)),
    notes: [
      hasNativeAssets
        ? 'Executor is published as an OS-native binary; Portable Host and Dedicated components require Node.js 22+ .cjs assets by default'
        : 'Node.js .cjs assets are the default; required OS-native Executor assets are added by the Executor release job',
      'run.sh is a wget-only bash bootstrap that prefers .cjs assets with Node.js 22+ and can use a published native Executor otherwise',
      'Portable uses kala-dashboard-with-runtime.cjs with embedded dashboard assets; Self-hosted Platform uses kala-runtime.cjs plus an independently activated dashboard release',
    ],
  }

  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(outDir, 'RELEASE_NOTES.md'), releaseNotes(manifest))
  createReleaseMetadataArchive({ releaseDir: outDir })
  manifest.assets.push(releaseMetadataArchiveName)
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  for (const name of ['sbom.cdx.json', 'THIRD_PARTY_NOTICES.txt', 'RELEASE_NOTES.md', 'dashboard-release.json']) rmSync(join(outDir, name), { force: true })
  writeSha256Sums(releaseFiles())
}

function writeDependencyMetadata() {
  const inventory = spawnSync('pnpm', ['licenses', 'list', '--prod', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, shell: process.platform === 'win32' })
  if (inventory.status !== 0) throw new Error(`production dependency license inventory failed (${inventory.error?.code ?? inventory.status ?? 'unknown'})`)
  const classes = JSON.parse(inventory.stdout)
  const components = []
  for (const [reportedLicense, packages] of Object.entries(classes)) {
    for (const dependency of packages) {
      const license = reportedLicense === 'Unknown' && dependency.name === 'khroma'
        ? 'MIT'
        : reportedLicense === 'Unknown' && (dependency.name === '@github/copilot' || dependency.name.startsWith('@github/copilot-'))
          ? 'LicenseRef-GitHub-Copilot-CLI'
          : reportedLicense
      if (license === 'Unknown') throw new Error(`unreviewed dependency license: ${dependency.name}`)
      for (const version of dependency.versions) {
        const encodedName = dependency.name.startsWith('@')
          ? dependency.name.split('/').map(encodeURIComponent).join('/')
          : encodeURIComponent(dependency.name)
        components.push({ type: 'library', name: dependency.name, version, purl: `pkg:npm/${encodedName}@${encodeURIComponent(version)}`, licenses: [{ license: { id: license } }] })
      }
    }
  }
  if (exists(WINDOWS_SERVICE_HOST.asset)) {
    components.push({
      type: 'application',
      name: WINDOWS_SERVICE_HOST.product,
      version: WINDOWS_SERVICE_HOST.version,
      hashes: [{ alg: 'SHA-256', content: WINDOWS_SERVICE_HOST.sha256 }],
      licenses: [{ license: { id: WINDOWS_SERVICE_HOST.license } }],
      externalReferences: [{ type: 'distribution', url: WINDOWS_SERVICE_HOST.sourceUrl }],
      properties: [
        { name: 'agent-runlab:release-asset', value: WINDOWS_SERVICE_HOST.asset },
        { name: 'agent-runlab:upstream-asset', value: WINDOWS_SERVICE_HOST.upstreamAsset },
        { name: 'agent-runlab:bytes', value: String(WINDOWS_SERVICE_HOST.bytes) },
      ],
    })
  }
  components.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: { type: 'application', name: 'kala', version: packageJson.version },
      properties: [
        { name: 'agent-runlab:source-revision', value: sourceIdentity.revision },
        { name: 'agent-runlab:source-snapshot-sha256', value: sourceIdentity.snapshotSha256 },
      ],
    },
    components,
  }
  writeFileSync(join(outDir, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`)
  const notices = [
    `Kala ${packageJson.version} third-party dependency inventory`,
    '',
    'The packages below retain their own copyright and license terms.',
    'Consult each upstream package for the complete license text and notices.',
    '',
    ...components.map((item) => `${item.name}@${item.version} — ${item.licenses[0].license.id}`),
    '',
    ...(exists(WINDOWS_SERVICE_HOST.asset) ? [
      `WinSW ${WINDOWS_SERVICE_HOST.version} — complete MIT license and copyright notice:`,
      readFileSync(join(root, 'scripts/release/licenses/WinSW-MIT.txt'), 'utf8').trimEnd(),
      '',
    ] : []),
  ]
  writeFileSync(join(outDir, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'))
}

function prepareBootstrapAssets() {
  const bootstrapAssets = []
  if (component === 'dashboard' || nativeOnly) return bootstrapAssets
  const runPath = join(outDir, 'run.sh')
  writeFileSync(runPath, unifiedBootstrap({ repo, tag, component }))
  chmodSync(runPath, 0o755)
  bootstrapAssets.push('run.sh')
  if (component === 'all' || component === 'host') {
    const posixManagerPath = join(outDir, POSIX_PORTABLE_MANAGER)
    writeFileSync(posixManagerPath, generatePosixPortableManager({ repo, tag }))
    chmodSync(posixManagerPath, 0o755)
    writeFileSync(join(outDir, WINDOWS_PORTABLE_MANAGER), generateWindowsPortableManager({ repo, tag }))
    bootstrapAssets.push(POSIX_PORTABLE_MANAGER, WINDOWS_PORTABLE_MANAGER)
  }
  if (component === 'all' || component === 'executor') {
    const windowsExecutable = executorNativeAssetName(WINDOWS_EXECUTOR_TARGET)
    const windowsCompanion = windowsNodePtyCompanionAssetName(WINDOWS_EXECUTOR_TARGET)
    const windowsServiceHost = WINDOWS_SERVICE_HOST.asset
    if (exists(windowsExecutable) || exists(windowsCompanion) || exists(windowsServiceHost)) {
      if (!exists(windowsExecutable) || !exists(windowsCompanion) || !exists(windowsServiceHost)) {
        throw new Error('Windows Executor, ConPTY companion, and service host must be staged together')
      }
      const installer = windowsExecutorInstallerAssetName()
      writeFileSync(join(outDir, installer), generateExecutorInstallerPowerShell({ repo, tag }))
      bootstrapAssets.push(installer, windowsCompanion, windowsServiceHost)
    }
  }
  return bootstrapAssets
}

function writeSha256Sums(files) {
  const sums = files
    .filter((file) => exists(file))
    .map((file) => `${sha256(join(outDir, file))}  ${file}`)
    .join('\n')
  writeFileSync(join(outDir, 'SHA256SUMS'), `${sums}\n`)
}

function releaseFiles() {
  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  return [...manifest.assets, 'manifest.json']
}

function removeNativeBuildWorkspace() {
  rmSync(join(outDir, '.sea'), { recursive: true, force: true })
}

function exists(asset) {
  return existsSync(join(outDir, asset))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function normalizeNodeShebang(text) {
  return `#!/usr/bin/env node\n${text.replace(/^#![^\n]*\n/gm, '')}`
}

function keepSingleShebang(text) {
  const shebang = '#!/usr/bin/env node\n'
  if (!text.startsWith(shebang)) return text
  return shebang + text.slice(shebang.length).replaceAll(shebang, '')
}

function detectNativeTarget() {
  const os = process.platform
  const arch = process.arch
  const normalizedOs = os === 'win32' ? 'win32' : os === 'darwin' ? 'darwin' : os === 'linux' ? 'linux' : os
  const normalizedArch = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch
  if (!['linux', 'darwin', 'win32'].includes(normalizedOs)) {
    throw new Error(`unsupported native release os ${os}`)
  }
  if (!['x64', 'arm64'].includes(normalizedArch) || (normalizedOs === 'win32' && normalizedArch !== 'x64')) {
    throw new Error(`unsupported native release arch ${arch}`)
  }
  return `${normalizedOs}-${normalizedArch}`
}

function nativeAssetName(name, target) {
  if (!supportedNativeBuildTargets.includes(target)) throw new Error(`unsupported native release target ${target}`)
  return `${name}-${target}${target === WINDOWS_EXECUTOR_TARGET ? '.exe' : ''}`
}

function copilotRuntimeAssetNames(target) {
  if (!copilotRuntimeTargets.includes(target)) throw new Error(`unsupported Copilot runtime target ${target}`)
  return [`kala-copilot-runtime-${target}`, `kala-copilot-runtime-node-${target}.node`]
}

function stageCopilotRuntime(target) {
  const hostRequire = createRequire(join(root, 'packages/host/package.json'))
  const sdkRequire = createRequire(hostRequire.resolve('@github/copilot-sdk'))
  const packageName = `@github/copilot-sdk-${target}`
  const packageRoot = dirname(sdkRequire.resolve(`${packageName}/package.json`))
  const sourceDir = join(packageRoot, 'prebuilds', target)
  const wrapperName = process.platform === 'win32' ? 'copilot-runtime.exe' : 'copilot-runtime'
  const [wrapperAsset, libraryAsset] = copilotRuntimeAssetNames(target)
  copyFileSync(join(sourceDir, wrapperName), join(outDir, wrapperAsset))
  copyFileSync(join(sourceDir, 'runtime.node'), join(outDir, libraryAsset))
  chmodSync(join(outDir, wrapperAsset), 0o755)
}

function cjsAssetName(entry) {
  return `${entry.cjsName ?? entry.name}.cjs`
}

function embeddedDashboardBanner(dir) {
  assertDashboardDistReady(dir)
  const assets = []
  for (const file of walkFiles(dir)) {
    const rel = relative(dir, file).replace(/\\/g, '/')
    assets.push({ path: rel, contentBase64: readFileSync(file).toString('base64') })
  }
  return `globalThis.__KALA_EMBEDDED_DASHBOARD__=${JSON.stringify(assets)};\n`
}

function writeDashboardReleaseManifest(dir) {
  assertDashboardDistReady(dir)
  const files = [...walkFiles(dir)].map((file) => {
    const path = relative(dir, file).replace(/\\/g, '/')
    const bytes = readFileSync(file)
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const assetDigest = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  writeFileSync(join(outDir, 'dashboard-release.json'), `${JSON.stringify({
    schemaVersion: 1,
    product: 'kala-dashboard',
    version: packageJson.version,
    builtAt: releaseBuiltAt,
    source: sourceIdentity,
    protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
    assetDigest,
    files,
  }, null, 2)}\n`)
}

function embeddedDocsBanner(dir) {
  const assets = []
  for (const file of walkFiles(dir)) {
    if (!file.toLowerCase().endsWith('.md')) continue
    const rel = relative(dir, file).replace(/\\/g, '/')
    assets.push({ path: rel, contentBase64: readFileSync(file).toString('base64') })
  }
  return `globalThis.__KALA_EMBEDDED_DOCS__=${JSON.stringify(assets)};\n`
}

function assertDashboardDistReady(dir) {
  if (!existsSync(join(dir, 'index.html'))) {
    throw new Error(`dashboard dist missing index.html at ${dir}; run pnpm --filter @agent-kernel/dashboard build or omit --skip-dashboard-build`)
  }
}

function embeddedSocketAdminBanner(dir) {
  if (!existsSync(join(dir, 'index.html'))) {
    throw new Error(`Socket.IO Admin UI dist missing index.html at ${dir}; run pnpm prepare:socket-admin-ui first`)
  }
  const assets = []
  for (const file of walkFiles(dir)) {
    const rel = relative(dir, file).replace(/\\/g, '/')
    assets.push({ path: rel, contentBase64: readFileSync(file).toString('base64') })
  }
  return `globalThis.__KALA_EMBEDDED_SOCKET_ADMIN_UI__=${JSON.stringify(assets)};\n`
}

function resolveSocketAdminDist() {
  const configured = process.env.KALA_SOCKET_ADMIN_DIST
  if (configured) return configured

  const localPrepared = join(root, '.presq/socket.io-admin-ui/dist')
  if (existsSync(join(localPrepared, 'index.html'))) return localPrepared

  try {
    const hostRequire = createRequire(new URL('../../packages/host/package.json', import.meta.url))
    const packageRoot = dirname(hostRequire.resolve('@socket.io/admin-ui/package.json'))
    return join(packageRoot, 'ui/dist')
  } catch {}

  return localPrepared
}

function prepareEmbeddedReleaseAssetsForHost() {
  const executorEntry = allEntries.find((entry) => entry.component === 'executor')
  if (!executorEntry) return ''
  const executorCjs = cjsAssetName(executorEntry)
  if (!exists('run.sh')) {
    const path = join(outDir, 'run.sh')
    writeFileSync(path, unifiedBootstrap({ repo, tag, component }))
    chmodSync(path, 0o755)
  }
  const nativeExecutor = currentNativeTarget ? executorNativeAssetName(currentNativeTarget) : undefined
  const desktopDownloadDir = join(dashboardDist, 'downloads', 'desktop')
  const desktopManifestPath = join(desktopDownloadDir, 'release.json')
  const desktopNames = []
  if (existsSync(desktopManifestPath)) {
    const desktopManifest = JSON.parse(readFileSync(desktopManifestPath, 'utf8'))
    const assets = [
      [desktopManifest.artifact?.file, 'desktop-package.deb'],
      [desktopManifest.dependencies?.file, 'desktop-dependencies.json'],
      [desktopManifest.checksums?.file, 'desktop-SHA256SUMS.txt'],
      ['install.sh', 'desktop-install.sh'],
    ]
    for (const [source, target] of assets) {
      if (typeof source !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+~-]*$/u.test(source)) throw new Error('invalid Desktop release asset name')
      copyFileSync(join(desktopDownloadDir, source), join(outDir, target))
      desktopNames.push(target)
    }
  }
  const embeddedNames = [executorCjs, nativeExecutor, 'run.sh', ...desktopNames]
    .filter((name) => name && exists(name))
  writeSha256Sums(embeddedNames)
  return embeddedReleaseAssetsBanner(outDir, [...embeddedNames, 'SHA256SUMS'])
}

function embeddedReleaseAssetsBanner(dir, names) {
  const assets = []
  for (const name of names) {
    const file = join(dir, name)
    if (!existsSync(file) || !statSync(file).isFile()) continue
    assets.push({ path: name, contentBase64: readFileSync(file).toString('base64') })
  }
  if (assets.length === 0) return ''
  return `globalThis.__KALA_EMBEDDED_RELEASE_ASSETS__=${JSON.stringify(assets)};\n`
}

function buildInfoBanner({ artifactKind, dashboardMode, socketAdminMode }) {
  const info = {
    releaseTag: tag,
    productVersion: packageJson.version,
    gitCommit: sourceIdentity.revision.slice(0, 12),
    sourceSnapshotSha256: sourceIdentity.snapshotSha256,
    builtAt: releaseBuiltAt,
    artifactKind,
    dashboardMode,
    socketAdminMode,
  }
  return `globalThis.__KALA_BUILD_INFO__=${JSON.stringify(info)};\n`
}

function readSourceIdentity() {
  const revision = options.sourceRevision ?? gitText(['rev-parse', 'HEAD']).trim()
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error('release source revision is unavailable')
  // Docker build contexts intentionally omit .git. Hash their copied source
  // separately and never claim a gitless build has a verified clean worktree.
  if (!existsSync(join(root, '.git'))) {
    if (!options.sourceRevision) throw new Error('gitless release build requires --source-revision')
    return { revision, snapshotSha256: gitlessSourceSnapshotSha256(), dirty: true }
  }

  if (options.sourceRevision && revision !== gitText(['rev-parse', 'HEAD']).trim()) {
    throw new Error('release source revision does not match Git HEAD')
  }
  return {
    revision,
    snapshotSha256: sourceSnapshotSha256(),
    dirty: gitText(['status', '--porcelain=v1', '--untracked-files=all']).trim().length > 0,
  }
}

function deterministicBuildTime() {
  const explicit = process.env.SOURCE_DATE_EPOCH
  const seconds = explicit === undefined
    ? existsSync(join(root, '.git'))
      ? Number(gitText(['show', '-s', '--format=%ct', 'HEAD']).trim())
      : 0
    : Number(explicit)
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer')
  return new Date(seconds * 1000).toISOString()
}

function assertSourceIdentityUnchanged() {
  const snapshot = existsSync(join(root, '.git')) ? sourceSnapshotSha256() : gitlessSourceSnapshotSha256()
  if (snapshot !== sourceIdentity.snapshotSha256) {
    throw new Error('release source changed while assets were being built')
  }
}

function assertStagedSourceIdentity() {
  if (!finalizeOnly || !exists('manifest.json')) return
  const staged = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')).source
  if (staged?.revision !== sourceIdentity.revision || staged?.snapshotSha256 !== sourceIdentity.snapshotSha256 || staged?.dirty !== sourceIdentity.dirty) {
    throw new Error('staged release source identity does not match the finalizing checkout')
  }
}

function gitlessSourceSnapshotSha256() {
  const hash = createHash('sha256')
  const roots = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'packages', 'docs', 'scripts/release', 'resources']
  function visit(path) {
    const absolute = join(root, path)
    if (!existsSync(absolute)) return
    const stat = lstatSync(absolute)
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (name === 'node_modules' || name === 'dist' || name === 'release' || name.startsWith('.')) continue
        visit(`${path}/${name}`)
      }
      return
    }
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute)
    hash.update(`${stat.mode & 0o7777}\0${path}\0${content.length}\0`)
    hash.update(content)
    hash.update('\0')
  }
  for (const path of roots) visit(path)
  return hash.digest('hex')
}

function sourceSnapshotSha256() {
  const hash = createHash('sha256')
  // A clean release tag has exactly the checked-in Git index as its source.
  // Hash its tracked mode, path, and content-addressed blob identity instead of
  // OS stat modes/CRLF checkout bytes, which differ on Windows and Unix runners.
  // Dirty local builds still hash every actual worktree file below.
  if (gitText(['status', '--porcelain=v1', '--untracked-files=all']).trim() === '') {
    const entries = gitBuffer(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean).sort()
    for (const entry of entries) {
      const match = entry.match(/^(100644|100755|120000) ([0-9a-f]{40,64}) 0\t(.+)$/u)
      if (!match) throw new Error('release Git index contains an unsupported or unresolved entry')
      hash.update(`${match[1]}\0${match[3]}\0${match[2]}\0`)
    }
    return hash.digest('hex')
  }
  const paths = gitBuffer(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString('utf8').split('\0').filter(Boolean).filter((path) => existsSync(join(root, path))).sort()
  for (const path of paths) {
    const absolute = join(root, path)
    const stat = lstatSync(absolute)
    const content = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute)
    hash.update(`${stat.mode & 0o7777}\0${path}\0${content.length}\0`)
    hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function gitText(args) {
  return gitBuffer(args).toString('utf8')
}

function gitBuffer(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: null, maxBuffer: 128 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(result.stderr?.toString('utf8') || `git ${args[0]} failed`)
  return result.stdout
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(abs)
    } else if (entry.isFile()) {
      const st = statSync(abs)
      if (st.size > 0) yield abs
    }
  }
}

async function buildNativeSea(name, cjsPath, target) {
  const seaDir = join(outDir, '.sea', `${name}-${target}`)
  mkdirSync(seaDir, { recursive: true })
  const seaConfigPath = join(seaDir, 'sea-config.json')
  const blobPath = join(seaDir, `${name}.blob`)
  const nativePath = join(outDir, nativeAssetName(name, target))
  writeFileSync(seaConfigPath, `${JSON.stringify({ main: cjsPath, output: blobPath, disableExperimentalSEAWarning: true }, null, 2)}\n`)
  await run(process.execPath, ['--experimental-sea-config', seaConfigPath])
  copyFileSync(process.execPath, nativePath)
  const postjectArgs = ['exec', 'postject', nativePath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']
  if (target.startsWith('darwin-')) {
    await run('codesign', ['--remove-signature', nativePath])
    postjectArgs.push('--macho-segment-name', 'NODE_SEA')
  }
  await run('pnpm', postjectArgs)
  if (target.startsWith('darwin-')) await run('codesign', ['--sign', '-', nativePath])
  chmodSync(nativePath, 0o755)
}

function parseOptions(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  const value = optionValue(normalized, '--component') ?? 'all'
  const allowed = new Set(['all', 'host', 'executor', 'dashboard'])
  if (!allowed.has(value)) {
    throw new Error(`unknown release component ${value}; expected all, host, executor, or dashboard`)
  }
  return {
    component: value,
    tag: optionValue(normalized, '--tag') ?? process.env.GITHUB_REF_NAME ?? 'latest',
    repo: optionValue(normalized, '--repo') ?? process.env.GITHUB_REPOSITORY,
    nativeOnly: normalized.includes('--native-only'),
    finalizeOnly: normalized.includes('--finalize-only'),
    noNative: normalized.includes('--no-native'),
    skipDashboardBuild: normalized.includes('--skip-dashboard-build'),
    skipPackageBuild: normalized.includes('--skip-package-build'),
    nativeTarget: optionValue(normalized, '--native-target'),
    sourceRevision: optionValue(normalized, '--source-revision'),
  }
}

function optionValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === name) return args[i + 1]
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

function repoFromPackageJson(pkg) {
  const repository = pkg.repository
  if (typeof repository === 'string') return normalizeRepo(repository)
  if (repository && typeof repository.url === 'string') return normalizeRepo(repository.url)
  return undefined
}

function normalizeRepo(value) {
  const trimmed = value.trim()
  const match = trimmed.match(/github\.com[:/]([^/]+\/[^/.#]+)(?:\.git)?(?:[#?].*)?$/)
  if (match) return match[1]
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return trimmed
  return undefined
}

function unifiedBootstrap({ repo, tag, component }) {
  const defaultComponent = component === 'all' ? 'host-frontend' : (component === 'dashboard' ? 'frontend' : component)
  return bash([
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    `REPO="${repo}"`,
    `TAG="${tag}"`,
    `DEFAULT_COMPONENT="${defaultComponent}"`,
    'DEFAULT_BASE_URL="https://github.com/${REPO}/releases/download/${TAG}"',
    'if [ "$TAG" = "latest" ]; then',
    '  DEFAULT_BASE_URL="https://github.com/${REPO}/releases/latest/download"',
    'fi',
    'BASE_URL="${KALA_RELEASE_BASE_URL:-$DEFAULT_BASE_URL}"',
    'case "$BASE_URL" in',
    '  https://*) PUBLIC_RELEASE=1 ;;',
    '  http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*|http://\\[::1\\]|http://\\[::1\\]:*) PUBLIC_RELEASE=0 ;;',
    '  http://*) if [ "${KALA_RELEASE_TRUST:-}" = "host" ]; then PUBLIC_RELEASE=0; else echo "Release downloads require HTTPS except for loopback URLs" >&2; exit 1; fi ;;',
    '  *) echo "Release downloads require HTTPS except for loopback URLs" >&2; exit 1 ;;',
    'esac',
    'COMPONENT="${COMPONENT:-${KALA_COMPONENT:-${1:-$DEFAULT_COMPONENT}}}"',
    'BOOTSTRAP_LOG_LEVEL="${KALA_BOOTSTRAP_LOG_LEVEL:-info}"',
    'VERIFY_SIGSTORE="$PUBLIC_RELEASE"',
    'if [ "${KALA_RELEASE_TRUST:-}" = "host" ]; then',
    '  host_asset_base="${HOST_URL%/}/install/assets"',
    '  if [ "${1:-}" != "--internal-installer" ] || [ -z "${EXECUTOR_INSTALL_ID:-}" ] || [ -z "${EXECUTOR_INSTALL_BOOTSTRAP:-}" ] || [ "$BASE_URL" != "$host_asset_base" ]; then',
    '    echo "Host-mediated release trust requires a valid internal installation session" >&2',
    '    exit 1',
    '  fi',
    '  VERIFY_SIGSTORE=0',
    'fi',
    '',
    'print_download_example() {',
    '  local example_component="$1"',
    '  local env_prefix="${2:-}"',
    '  if [ -n "$env_prefix" ]; then',
    '    env_prefix="$env_prefix "',
    '  fi',
    '  printf "  tmp=\\$(mktemp)\\n" >&2',
    '  printf "  wget -nv -O \\\"\\$tmp\\\" \\\"%s/run.sh\\\"\\n" "$BASE_URL" >&2',
    '  printf "  %sCOMPONENT=%s bash \\\"\\$tmp\\\"\\n" "$env_prefix" "$example_component" >&2',
    '}',
    '',
    'USER_WORK_DIR="${KALA_RUN_DIR:-}"',
    'if [ -n "$USER_WORK_DIR" ]; then',
    '  WORK_DIR="$USER_WORK_DIR"',
    '  mkdir -p "$WORK_DIR"',
    'else',
    '  WORK_DIR=$(mktemp -d)',
    '  trap \'rm -rf "$WORK_DIR"\' EXIT',
    'fi',
    '',
    'case "$COMPONENT" in',
    '  host|executor|frontend|host-frontend) ;;',
    '  *)',
    '    echo "Unknown COMPONENT: \"$COMPONENT\". Set COMPONENT to one of:" >&2',
    '    echo >&2',
    '    echo "  host-frontend  Run the host process AND serve the dashboard bundle (one-command VM deploy). DEFAULT." >&2',
    '    echo "  host           Run only the headless host process (no web UI). Pair with a separately deployed frontend." >&2',
    '    echo "  frontend       Download and extract the dashboard bundle only; do not start any process." >&2',
    '    echo "  executor       Run an executor that dials into an existing host. Requires HOST_URL." >&2',
    '    echo >&2',
    '    echo "Examples:" >&2',
    '    print_download_example host-frontend',
    '    echo >&2',
    '    print_download_example host',
    '    echo >&2',
    '    print_download_example frontend',
    '    echo >&2',
    '    print_download_example executor HOST_URL=http://127.0.0.1:3000',
    '    exit 1',
    '    echo "  tmp=\\$(mktemp)" >&2',
    '    echo "  wget -nv -O \"\\$tmp\" \"${BASE_URL}/run.sh\"" >&2',
    '    echo "  COMPONENT=host-frontend bash \"\\$tmp\"" >&2',
    '    echo >&2',
    '    echo "  tmp=\\$(mktemp)" >&2',
    '    echo "  wget -nv -O \"\\$tmp\" \"${BASE_URL}/run.sh\"" >&2',
    '    echo "  COMPONENT=host bash \"\\$tmp\"" >&2',
    '    echo >&2',
    '    echo "  tmp=\\$(mktemp)" >&2',
    '    echo "  wget -nv -O \"\\$tmp\" \"${BASE_URL}/run.sh\"" >&2',
    '    echo "  COMPONENT=frontend bash \"\\$tmp\"" >&2',
    '    echo >&2',
    '    echo "  tmp=\\$(mktemp)" >&2',
    '    echo "  wget -nv -O \"\\$tmp\" \"${BASE_URL}/run.sh\"" >&2',
    '    echo "  HOST_URL=http://host-machine:3000 COMPONENT=executor bash \"\\$tmp\"" >&2',
    '    exit 1',
    '    ;;',
    'esac',
    'if [ "$COMPONENT" = "executor" ] && [ -z "${HOST_URL:-}" ] && [ "$#" -eq 0 ]; then',
    '  echo "COMPONENT=executor requires HOST_URL (URL of the running host to dial into)." >&2',
    '  echo "  Example:" >&2',
    '  print_download_example executor HOST_URL=http://127.0.0.1:3000',
    '  exit 1',
    '  echo "    tmp=\\$(mktemp)" >&2',
    '  echo "    wget -nv -O \"\\$tmp\" \"${BASE_URL}/run.sh\"" >&2',
    '  echo "    HOST_URL=http://host-machine:3000 COMPONENT=executor bash \"\\$tmp\"" >&2',
    '  exit 1',
    'fi',
    '',
    'FRONTEND_DIR="${KALA_FRONTEND_DIR:-${WORK_DIR}/frontend}"',
    'case "$COMPONENT" in',
    '  frontend|host-frontend) mkdir -p "$FRONTEND_DIR" ;;',
    'esac',
    '',
    'require_cmd() {',
    '  if ! command -v "$1" >/dev/null 2>&1; then',
    '    echo "Required command \'$1\' not found in PATH" >&2',
    '    exit 1',
    '  fi',
    '}',
    'require_cmd wget',
    'if [ "$VERIFY_SIGSTORE" = "1" ]; then require_cmd cosign; fi',
    '',
    'log() {',
    '  printf "Kala bootstrap | %s\\n" "$*" >&2',
    '}',
    '',
    'debug() {',
    '  if [ "$BOOTSTRAP_LOG_LEVEL" = "debug" ]; then',
    '    log "$@"',
    '  fi',
    '}',
    '',
    'download() {',
    '  local name="$1"',
    '  local url="${BASE_URL}/${name}"',
    '  log "download ${name}"',
    '  debug "source ${url}"',
    '  if ! wget -q --tries=3 --timeout=30 --retry-connrefused -O "${WORK_DIR}/${name}" "$url"; then',
    '    log "failed to download ${name}"',
    '    log "source ${url}"',
    '    log "check network reachability and release tag ${TAG} in ${REPO}"',
    '    exit 1',
    '  fi',
    '}',
    '',
    'hash_file() {',
    '  if command -v shasum >/dev/null 2>&1; then',
    '    shasum -a 256 "$1" | awk \'{print $1}\'',
    '  elif command -v sha256sum >/dev/null 2>&1; then',
    '    sha256sum "$1" | awk \'{print $1}\'',
    '  else',
    '    echo "Required command \'shasum\' or \'sha256sum\' not found in PATH" >&2',
    '    exit 1',
    '  fi',
    '}',
    '',
    'verify_file() {',
    '  local name="$1"',
    '  local expected',
    '  expected=$(awk -v file="$name" \'$2 == file {print $1}\' "${WORK_DIR}/SHA256SUMS")',
    '  if [ -z "$expected" ]; then',
    '    log "SHA256SUMS has no checksum for $name; release may be missing this asset"',
    '    exit 1',
    '  fi',
    '  local actual',
    '  actual=$(hash_file "${WORK_DIR}/${name}")',
    '  if [ "$actual" != "$expected" ]; then',
    '    log "checksum mismatch for $name"',
    '    log "expected $expected"',
    '    log "actual   $actual"',
    '    exit 1',
    '  fi',
    '  debug "verified ${name}"',
    '}',
    '',
    'download SHA256SUMS',
    'if [ "$VERIFY_SIGSTORE" = "1" ]; then',
    '  download SHA256SUMS.sigstore.json',
    '  cosign verify-blob --bundle "${WORK_DIR}/SHA256SUMS.sigstore.json" --certificate-identity-regexp "^https://github.com/${REPO}/.github/workflows/release\\.yml@refs/tags/v" --certificate-oidc-issuer "https://token.actions.githubusercontent.com" "${WORK_DIR}/SHA256SUMS" >/dev/null',
    'fi',
    '',
    'platform_target() {',
    '  local os arch',
    '  os=$(uname -s | tr "[:upper:]" "[:lower:]")',
    '  arch=$(uname -m)',
    '  case "$os" in',
    '    linux) os="linux" ;;',
    '    darwin) os="darwin" ;;',
    '    *) echo ""; return ;;',
    '  esac',
    '  case "$arch" in',
    '    x86_64|amd64) arch="x64" ;;',
    '    arm64|aarch64) arch="arm64" ;;',
    '    *) echo ""; return ;;',
    '  esac',
    '  echo "${os}-${arch}"',
    '}',
    '',
    'checksum_exists() {',
    '  local name="$1"',
    '  awk -v file="$name" \'$2 == file {found=1} END {exit found ? 0 : 1}\' "${WORK_DIR}/SHA256SUMS"',
    '}',
    '',
    'has_node22() {',
    '  command -v node >/dev/null 2>&1 && node -e \'const major=Number(process.versions.node.split(".")[0]); process.exit(major >= 22 ? 0 : 1)\' >/dev/null 2>&1',
    '}',
    '',
    'download_and_extract_frontend() {',
    '  require_cmd tar',
    '  download kala-dashboard.tar.gz',
    '  verify_file kala-dashboard.tar.gz',
    '  tar -xzf "${WORK_DIR}/kala-dashboard.tar.gz" -C "$FRONTEND_DIR"',
    '  if [ ! -f "${FRONTEND_DIR}/index.html" ]; then',
    '    echo "Extracted frontend bundle to $FRONTEND_DIR but index.html is missing" >&2',
    '    exit 1',
    '  fi',
    '}',
    '',
    'run_asset() {',
    '  local base="$1"',
    '  shift',
    '  local target native cjs runtime',
    '  target=$(platform_target)',
    '  native="${base}-${target}"',
    '  cjs="${base}.cjs"',
    '  if [ "$base" = "kala-host" ]; then',
    '    cjs="kala-dashboard-with-runtime.cjs"',
    '  fi',
    '  runtime="${KALA_RUNTIME:-auto}"',
    '  case "$runtime" in auto|cjs|native) ;; *) echo "KALA_RUNTIME must be auto, cjs, or native" >&2; exit 1 ;; esac',
    '  if [ "$runtime" = "cjs" ] || { [ "$runtime" = "auto" ] && has_node22; }; then',
    '    if checksum_exists "$cjs"; then',
    '      download "$cjs"',
    '      verify_file "$cjs"',
    '      chmod +x "${WORK_DIR}/${cjs}"',
    '      KALA_RELEASE_TAG="$TAG" KALA_UPDATE_REPO="$REPO" exec node "${WORK_DIR}/${cjs}" "$@"',
    '    fi',
    '    if [ "$runtime" = "cjs" ]; then',
    '      log "missing checksum for $cjs"',
    '      exit 1',
    '    fi',
    '  fi',
    '  if [ -n "$target" ] && checksum_exists "$native"; then',
    '    download "$native"',
    '    verify_file "$native"',
    '    chmod +x "${WORK_DIR}/${native}"',
    '    KALA_RELEASE_TAG="$TAG" KALA_UPDATE_REPO="$REPO" exec "${WORK_DIR}/${native}" "$@"',
    '  fi',
    '  if [ "$runtime" = "native" ]; then',
    '    log "no native binary published for platform ${target:-unsupported}"',
    '    log "available runtimes: set KALA_RUNTIME=cjs (needs Node.js 22+) or unset it for auto"',
    '    exit 1',
    '  fi',
    '  if ! has_node22; then',
    '    log "no native binary for platform ${target:-unsupported} and no Node.js 22+ for .cjs fallback"',
    '    log "install Node.js 22+, or run on a platform with a published native binary"',
    '    exit 1',
    '  fi',
    '  download "$cjs"',
    '  verify_file "$cjs"',
    '  chmod +x "${WORK_DIR}/${cjs}"',
    '  KALA_RELEASE_TAG="$TAG" KALA_UPDATE_REPO="$REPO" exec node "${WORK_DIR}/${cjs}" "$@"',
    '}',
    '',
    'print_start_banner() {',
    '  local bind="${HOST:-127.0.0.1}"',
    '  local port="${PORT:-3000}"',
    '  log "starting host component=${COMPONENT} bind=${bind}:${port}"',
    '  if [ "$bind" = "0.0.0.0" ]; then',
    '    log "open http://<this-host-ip>:${port}"',
    '  else',
    '    log "open http://${bind}:${port}"',
    '    debug "set HOST=0.0.0.0 to expose on all interfaces"',
    '  fi',
    '  if [ "$COMPONENT" = "host-frontend" ]; then',
    '    log "frontend $FRONTEND_DIR"',
    '  else',
    '    log "headless host; deploy frontend separately"',
    '  fi',
    '}',
    '',
    'case "$COMPONENT" in',
    '  frontend)',
    '    download_and_extract_frontend',
    '    log "frontend ready $FRONTEND_DIR"',
    '    log "serve example: cd $FRONTEND_DIR && python3 -m http.server 8080"',
    '    log "browser example: ?host=http://<host-ip>:3000"',
    '    exit 0',
    '    ;;',
  '  host-frontend)',
    '    print_start_banner',
    '    run_asset kala-host "$@"',
    '    ;;',
    '  host)',
    '    print_start_banner',
    '    run_asset kala-host "$@"',
    '    ;;',
    '  executor)',
    '    case "${HOST_URL:-}" in',
    '      https://*|http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*|http://\\[::1\\]|http://\\[::1\\]:*) ;;',
    '      http://*) if [ "${KALA_RELEASE_TRUST:-}" != "host" ]; then log "HOST_URL requires HTTPS except for loopback URLs"; exit 1; fi ;;',
    '      *) log "HOST_URL requires HTTPS except for loopback URLs"; exit 1 ;;',
    '    esac',
    '    run_asset kala-executor "$@"',
    '    ;;',
    'esac',
  ])
}


function releaseNotes(manifest) {
  const changes = releaseNotesCatalog[manifest.tag] ?? {}
  const tagPath = manifest.tag === 'latest' ? 'latest/download' : `download/${manifest.tag}`
  const base = `https://github.com/${manifest.repo}/releases/${tagPath}`
  const canRunHost = manifest.component === 'all' || manifest.component === 'host'
  const canRunExecutor = manifest.component === 'all' || manifest.component === 'executor'
  const run = (component, extraEnv = '') => {
    const env = [extraEnv.trim(), `COMPONENT=${component}`].filter(Boolean).join(' ')
    return `set -o pipefail; curl --proto '=https' --tlsv1.2 -fsSL "${base}/run.sh" | ${env} bash`
  }
  const lines = [
    `# Kala ${manifest.tag}`,
    '',
    'Kala is a complete, self-hosted, cloud-native agent system for running agents',
    'across models, workspaces, machines, and tenants. It combines',
    'deterministic agent semantics, real-world execution, durable session',
    'infrastructure, and multi-tenant operations in one architecture.',
    '',
    'Its three layers form a single system: the Agent Kernel defines behavior, the',
    'Agent Runtime executes it, and the cloud-native service operates it reliably at',
    'deployment scale.',
    '',
    '## Improvements',
    '',
    ...releaseNoteBullets(changes.improvements, 'No user-facing improvements are recorded for this build.'),
    '',
    '## Fixes',
    '',
    ...releaseNoteBullets(changes.fixes, 'No user-facing fixes are recorded for this build.'),
    '',
    '## Known issues',
    '',
    ...releaseNoteBullets(changes.knownIssues, 'No release-specific known issues are recorded.'),
    '',
    '## Installation',
    '',
  ]
  if (manifest.assets.includes('run.sh')) {
    if (canRunHost) {
      lines.push(
        'Host and Dashboard:',
        '',
        '```bash',
        run('host-frontend'),
        '```',
        '',
      )
    }
    if (canRunExecutor) {
      lines.push(
        'Executor:',
        '',
        '```bash',
        run('executor', 'HOST_URL=https://agent.example.com'),
        '```',
        '',
      )
    }
  }
  if (changes.desktopDeb) {
    lines.push(
      'Linux Desktop (x64):',
      '',
      '```bash',
      `curl --proto '=https' --tlsv1.2 -fLO "${base}/${changes.desktopDeb}"`,
      `sudo apt install "./${changes.desktopDeb}"`,
      '```',
      '',
    )
  } else if (changes.desktopViaDashboard) {
    lines.push(
      'Linux Desktop (x64): install from the **Download desktop app** page in your Kala Dashboard.',
      '',
    )
  }
  lines.push(
    '## Supported platforms',
    '',
    '- Native Executor: Linux x64, macOS x64/arm64, and Windows x64 with the signed ConPTY companion.',
    '- Portable Host and Dedicated components: Node.js 22+ is required on each accepted platform.',
    changes.desktopDeb || changes.desktopViaDashboard
      ? '- Desktop application: Debian/Ubuntu x64.'
      : '- No Desktop application package is included.',
    '- Dashboard: current Chromium, Firefox, and Safari releases.',
    '- Linux arm64 and Windows arm64 release assets are not included in this release.',
    '',
    `See the [release support policy](https://github.com/${manifest.repo}/blob/${manifest.tag}/docs/operations/release-support-policy.md) for the validated support scope.`,
    '',
    '## Verification',
    '',
    'Set `ASSET` to the downloaded filename, then verify it against the signed checksum index:',
    '',
    '```bash',
    'ASSET=kala-dashboard-with-runtime.cjs',
    `curl --proto '=https' --tlsv1.2 -fLO "${base}/SHA256SUMS"`,
    `curl --proto '=https' --tlsv1.2 -fLO "${base}/SHA256SUMS.sigstore.json"`,
    `curl --proto '=https' --tlsv1.2 -fLO "${base}/$ASSET"`,
    'grep "  $ASSET$" SHA256SUMS | sha256sum -c -',
    `cosign verify-blob --bundle SHA256SUMS.sigstore.json --certificate-identity-regexp "https://github.com/${manifest.repo}/.github/workflows/release.yml@.*" --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS`,
    '```',
    '',
    'The release metadata archive also contains the SBOM and third-party notices.',
    '',
    '## Full changelog',
    '',
    changes.previousTag
      ? `[Compare ${changes.previousTag}...${manifest.tag}](https://github.com/${manifest.repo}/compare/${changes.previousTag}...${manifest.tag})`
      : `See the [commit history](https://github.com/${manifest.repo}/commits/${manifest.tag}).`,
    '',
  )
  return `${lines.join('\n')}\n`
}

function releaseNoteBullets(items, fallback) {
  return Array.isArray(items) && items.length > 0
    ? items.map((item) => `- ${item}`)
    : [`- ${fallback}`]
}

function bash(lines) {
  return `${lines.join('\n')}\n`
}

async function run(cmd, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} failed with ${code}`))
    })
  })
}
