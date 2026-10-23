import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('README presents Kala as the public project and installer repository', () => {
  const readme = read('README.md')
  assert.match(readme, /^# Kala$/m)
  assert.match(readme, /github\.com\/xingsy97\/kala\/releases\/latest\/download\/run\.sh/)
  assert.match(readme, /KALA_PROVIDER=openai/)
  assert.doesNotMatch(readme, /akernel|@agent-kernel|AK_PROVIDER/i)
})

test('evaluation images build orchestrator and dashboard from source', () => {
  for (const name of ['orchestrator', 'dashboard']) {
    const dockerfile = read(`deploy/evaluation/images/Dockerfile.${name}`)
    const dockerignore = read(`deploy/evaluation/images/Dockerfile.${name}.dockerignore`)
    assert.match(dockerfile, /FROM node:22-bookworm-slim AS build/)
    assert.match(dockerfile, /pnpm --filter @agent-kernel\/eval-(orchestrator|dashboard) build/)
    assert.match(dockerfile, /COPY --from=build/)
    assert.doesNotMatch(dockerfile, /COPY packages\/eval-(orchestrator|dashboard)\/dist/)
    assert.match(dockerignore, /!tsconfig\.base\.json/)
    assert.match(dockerignore, new RegExp(`!packages/eval-${name}/\\*\\*`))
  }
})

test('host build is clean and release verification rejects legacy evaluation content', () => {
  const host = JSON.parse(read('packages/host/package.json'))
  assert.match(host.scripts.build, /rmSync\('dist'/)
  const verifier = read('scripts/release/verify-release-assets.mjs')
  assert.match(verifier, /forbiddenLegacyEvaluationMarkers/)
  assert.match(verifier, /src\/eval\//)
})

test('release builders remove native scratch files and verification rejects undeclared files', () => {
  const builder = read('scripts/release/build-release-assets.mjs')
  const verifier = read('scripts/release/verify-release-assets.mjs')
  assert.match(builder, /removeNativeBuildWorkspace\(\)/)
  assert.match(builder, /rmSync\(join\(outDir, '\.sea'\), \{ recursive: true, force: true \}\)/)
  assert.match(verifier, /release file set does not exactly match its manifest/)
  assert.match(verifier, /actualReleaseEntries\.some\(\(entry\) => !entry\.isFile\(\)\)/)
  assert.match(builder, /assertStagedSourceIdentity\(\)/)
  assert.match(builder, /createDashboardArchive/)
  assert.match(builder, /createReleaseMetadataArchive/)
  assert.match(builder, /buildDedicatedSupportBundle/)
  assert.match(verifier, /manifest assets do not match the .* release contract/)
  assert.match(verifier, /verifyDashboardArchive/)
  assert.match(verifier, /inspectDedicatedSupportBundle/)
})

test('only explicitly requested SEA Executor builds resolve adjacent native addons', () => {
  const builder = read('scripts/release/build-release-assets.mjs')
  assert.match(builder, /const wantsNativeBuild = !finalizeOnly && nativeOnly/)
  assert.match(builder, /nativeOnly && component === 'executor' && copilotRuntimeTargets\.includes\(nativeTarget\)[\s\S]*stageCopilotRuntime\(nativeTarget\)/)
  assert.match(builder, /const nativeRequire = wantsNativeBuild && item\.role === 'executor'/)
  assert.match(builder, /createRequire\(__filename\)/)
  assert.match(builder, /\$\{nativeRequire\}\$\{buildInfo\}/)
})

test('macOS SEA assets use the required Mach-O segment and restore an ad-hoc signature', () => {
  const builder = read('scripts/release/build-release-assets.mjs')
  const removeSignature = builder.indexOf("await run('codesign', ['--remove-signature', nativePath])")
  const machoSegment = builder.indexOf("postjectArgs.push('--macho-segment-name', 'NODE_SEA')")
  const inject = builder.indexOf("await run('pnpm', postjectArgs)")
  const sign = builder.indexOf("await run('codesign', ['--sign', '-', nativePath])")
  assert.ok(removeSignature >= 0 && removeSignature < machoSegment)
  assert.ok(machoSegment < inject && inject < sign)
})

test('release docs include tracked files only and exclude the unfinished showcase', () => {
  const builder = read('scripts/release/build-release-assets.mjs')
  assert.match(builder, /spawnSync\('git', \['ls-files', '-z', '--', 'docs\/']/)
  assert.match(builder, /file !== 'docs\/assets\/kala-dashboard-preview\.gif'/)
  assert.match(builder, /'--null', '-T', '-'/)
})

test('Dashboard release manifest materializes the file iterator before mapping and sorting', () => {
  const builder = read('scripts/release/build-release-assets.mjs')
  assert.ok(builder.includes('const files = [...walkFiles(dir)].map'))
  assert.ok(!builder.includes('const files = walkFiles(dir).map'))
})

test('Dashboard release protocol range follows the shared wire protocol version', () => {
  const builder = read('scripts/release/build-release-assets.mjs')
  assert.match(builder, /await import\(pathToFileURL\(join\(root, 'packages\/shared\/dist\/index\.js'\)\)\.href\)/)
  assert.match(builder, /protocol: \{ min: PROTOCOL_VERSION, max: PROTOCOL_VERSION \}/)
  assert.doesNotMatch(builder, /protocol: \{ min: '1\.0\.0', max: '1\.0\.0' \}/)
})

test('release verification rejects embedded Dashboard assignment without rejecting runtime feature detection', () => {
  const verifier = read('scripts/release/verify-release-assets.mjs')
  assert.ok(verifier.includes("platformRuntime.includes('globalThis.__KALA_EMBEDDED_DASHBOARD__=')"))
  assert.ok(!verifier.includes("platformRuntime.includes('__KALA_EMBEDDED_DASHBOARD__')"))
})

test('release verifier enforces the exact four-platform default while builder exposes Windows build capability', () => {
  const builder = read('scripts/release/build-release-assets.mjs')
  const verifier = read('scripts/release/verify-release-assets.mjs')
  assert.match(builder, /const nativeTargets = \['linux-x64', 'darwin-x64', 'darwin-arm64', WINDOWS_EXECUTOR_TARGET\]/)
  assert.match(builder, /const supportedNativeBuildTargets = nativeTargets/)
  assert.match(builder, /generateExecutorInstallerPowerShell/)
  assert.match(builder, /packageWindowsNodePtyCompanion/)
  assert.doesNotMatch(builder, /name: '(?:agent-kernel|agent-runlab|runlab)-|cjsName: 'bundle-dashboard-with-runtime'/)
  assert.match(builder, /stageCopilotRuntime/)
  assert.doesNotMatch(builder, /generateExecutorInstallerSh|COPILOT_CLI_PATH/)
  assert.match(builder, /Release downloads require HTTPS except for loopback URLs/)
  assert.match(builder, /cosign verify-blob/)
  assert.match(builder, /KALA_RELEASE_TRUST/)
  assert.match(builder, /Host-mediated release trust requires a valid internal installation session/)
  assert.match(builder, /\$\{1:-\}" != "--internal-installer"/)
  assert.match(builder, /\[ "\$BASE_URL" != "\$host_asset_base" \]/)
  assert.match(builder, /if \[ "\$VERIFY_SIGSTORE" = "1" \]; then require_cmd cosign; fi/)
  for (const section of ['Improvements', 'Fixes', 'Known issues', 'Installation', 'Supported platforms', 'Verification', 'Full changelog']) assert.match(builder, new RegExp(section))
  assert.match(verifier, /supportedNativeTargets = \['linux-x64', 'darwin-x64', 'darwin-arm64', 'win32-x64'\]/)
  assert.match(verifier, /acceptedWindows/)
  assert.match(verifier, /const acceptedWindows = new Set\(\[[\s\S]*?\n    WINDOWS_PORTABLE_MANAGER,/u)
  assert.match(verifier, /linux-arm64/)
  assert.match(verifier, /assertSupportedReleaseAssetName\(asset\?\.path, 'embedded Host assets'\)/)
  assert.match(verifier, /executor-update-/)
})

test('root tests expose fast and extended aggregation without experiments', () => {
  const root = JSON.parse(read('package.json'))
  assert.equal(root.scripts.test, 'pnpm run test:fast')
  for (const script of ['test:fast', 'test:extended', 'test:workspace', 'test:scripts', 'test:task-packs', 'test:python']) {
    assert.equal(typeof root.scripts[script], 'string')
  }
  assert.match(root.scripts['test:extended'], /test:python/)
  assert.doesNotMatch(root.scripts.test + root.scripts['test:fast'] + root.scripts['test:extended'], /experiments|references/)
})
