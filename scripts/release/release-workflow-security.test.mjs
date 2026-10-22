import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { requiredReleaseEvidence } from './rc-evidence.mjs'
import { windowsServiceHostManifestMetadata } from './windows-service-host.mjs'

const reconcile = join(import.meta.dirname, 'reconcile-github-release-assets.mjs')
const verifyPromotion = join(import.meta.dirname, 'verify-promotion-candidate.mjs')
const digest = (value) => createHash('sha256').update(value).digest('hex')

test('Windows acceptance builds real workspace dependencies instead of a quoted empty pnpm filter', () => {
  const scripts = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')).scripts
  for (const name of ['build', 'typecheck']) {
    assert.match(scripts[name], /pnpm -r --filter=!@agent-kernel\/desktop run build/u)
    assert.doesNotMatch(scripts[name], /--filter ['"]!@agent-kernel\/desktop['"]/u)
  }
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/rc-acceptance.yml'), 'utf8')
  assert.match(workflow, /windows-portable-conpty:[\s\S]*pnpm --filter @agent-kernel\/shared\.\.\. run build[\s\S]*Prove Windows Node\.js 22 Host/u)
})

test('gitless Private Cloud runtime context includes tracked release bootstrap inputs', () => {
  const dockerfile = readFileSync(join(import.meta.dirname, '../../deploy/private-cloud/images/Dockerfile.runtime-service'), 'utf8')
  for (const directory of ['docs', 'deploy/dedicated-systemd', 'scripts/deploy', 'scripts/release']) {
    assert.match(dockerfile, new RegExp(`^COPY ${directory} ${directory}$`, 'mu'))
  }
  assert.match(dockerfile, /docs\/\.tracked-release-docs/u)
})

test('Private Cloud runtime image receives an exact-tag sealed Windows Executor capture', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/private-cloud-release.yml'), 'utf8')
  const dockerfile = readFileSync(join(import.meta.dirname, '../../deploy/private-cloud/images/Dockerfile.runtime-service'), 'utf8')
  const windows = workflow.slice(workflow.indexOf('  windows-assets:'), workflow.indexOf('  runtime-image:'))
  const runtime = workflow.slice(workflow.indexOf('  runtime-image:'), workflow.indexOf('  ingress-image:'))

  assert.match(workflow, /revision: \$\{\{ steps\.release\.outputs\.revision \}\}[\s\S]*git rev-parse "\$TAG\^\{commit\}"/u)
  assert.match(windows, /runs-on: windows-latest[\s\S]*ref: '\$\{\{ needs\.resolve\.outputs\.revision \}\}'[\s\S]*--native-target win32-x64/u)
  assert.match(windows, /CAPTURE_REVISION: '\$\{\{ needs\.resolve\.outputs\.revision \}\}'[\s\S]*windows-capture-manifest\.json[\s\S]*schemaVersion:1/u)
  assert.match(windows, /name: private-cloud-windows-captured-assets[\s\S]*if-no-files-found: error/u)
  assert.match(runtime, /needs: \[resolve, windows-assets\][\s\S]*ref: '\$\{\{ needs\.resolve\.outputs\.revision \}\}'[\s\S]*git rev-parse HEAD[\s\S]*actions\/download-artifact@v5[\s\S]*private-cloud-windows-captured-assets/u)
  assert.match(runtime, /manifest\.revision !== process\.env\.EXPECTED_REVISION[\s\S]*manifest inventory is not exact[\s\S]*artifact inventory is not closed[\s\S]*Windows capture checksum mismatch/u)
  assert.match(runtime, /SOURCE_REVISION=\$\{\{ needs\.resolve\.outputs\.revision \}\}[\s\S]*RELEASE_TAG=\$\{\{ needs\.resolve\.outputs\.tag \}\}/u)
  assert.doesNotMatch(runtime, /gh release|releases\/download/u)

  for (const asset of ['kala-executor-win32-x64.exe', 'kala-executor-service-host-win32-x64.exe', 'node-pty-win32-x64.tar.gz']) {
    assert.match(dockerfile, new RegExp(`cp /tmp/windows-assets/${asset.replaceAll('.', '\\.')} release/`, 'u'))
  }
  assert.match(dockerfile, /chmod \+x release\/kala-executor-win32-x64\.exe release\/kala-executor-service-host-win32-x64\.exe/u)
  assert.match(dockerfile, /embed-windows-assets-in-portable-host\.mjs[\s\S]*--finalize-only[\s\S]*pnpm run verify:release-assets -- --private-cloud-runtime/u)
  const verifier = readFileSync(join(import.meta.dirname, 'verify-release-assets.mjs'), 'utf8')
  assert.match(verifier, /privateCloudRuntime = process\.argv\.includes\('--private-cloud-runtime'\)/u)
  assert.match(verifier, /JSON\.stringify\(actualNativeTargets\) !== JSON\.stringify\(\['win32-x64'\]\)/u)
  assert.match(verifier, /'manifest.nativeTargets must be empty for a CJS-only stage or contain exactly the four supported Executor targets'/u)
  assert.match(dockerfile, /COPY --from=build --chown=65532:65532 \/app\/release\/ \/app\/release\//u)
})

test('Private Cloud image and bundle jobs use exactly the tag revision even on manual dispatch', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/private-cloud-release.yml'), 'utf8')
  for (const [name, next] of [
    ['runtime-image', 'ingress-image'], ['ingress-image', 'dashboard-image'],
    ['dashboard-image', 'image-vulnerability-scan'], ['image-vulnerability-scan', 'operator'],
    ['operator', 'bundle'], ['bundle', 'fresh_beta_candidate_assets'],
  ]) {
    const job = workflow.slice(workflow.indexOf(`  ${name}:`), workflow.indexOf(`  ${next}:`))
    assert.match(job, /uses: actions\/checkout@v5\s+with: \{ ref: '\$\{\{ needs\.resolve\.outputs\.revision \}\}' \}/u, `${name} must checkout the tag commit`)
    assert.doesNotMatch(job, /\$\{\{ github\.sha \}\}/u, `${name} must not label a branch HEAD as the release tag`)
  }
  assert.match(workflow, /--revision "\$\{\{ needs\.resolve\.outputs\.revision \}\}"/u)
})

test('Private Cloud images derive a minimal Node runtime and exclude unused OpenSSL and build tooling', () => {
  const builderDigest = 'sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c'
  const runtimeDigest = 'sha256:5ef534d3db0ac0c43bee379af4ae49cfbfc0ef38a46c94c52d87c68f32f34d8a'
  for (const name of ['runtime-service', 'runtime-ingress-gateway', 'dashboard']) {
    const dockerfile = readFileSync(join(import.meta.dirname, `../../deploy/private-cloud/images/Dockerfile.${name}`), 'utf8')
    assert.equal(dockerfile.match(new RegExp(`FROM node@${builderDigest}`, 'gu'))?.length, 1)
    assert.equal(dockerfile.match(new RegExp(`FROM gcr\\.io/distroless/nodejs22-debian13@${runtimeDigest}`, 'gu'))?.length, 1)
    assert.equal(dockerfile.match(/^FROM scratch AS node-runtime$/gmu)?.length, 1)
    assert.equal(dockerfile.match(/^FROM node-runtime AS runtime$/gmu)?.length, 1)
    assert.match(dockerfile, /^COPY --from=node-runtime-source \/nodejs\/bin\/node \/nodejs\/bin\/node$/mu)
    assert.match(dockerfile, /^COPY --from=node-runtime-source --chmod=1777 \/tmp \/tmp$/mu)
    assert.match(dockerfile, /^ENTRYPOINT \["\/nodejs\/bin\/node"\]$/mu)
    assert.doesNotMatch(dockerfile, /^COPY --from=node-runtime-source \/ \/$/mu)
    assert.doesNotMatch(dockerfile, /^COPY --from=node-runtime-source .*libssl/mu)
    assert.doesNotMatch(dockerfile, /^COPY --from=node-runtime-source .*status\.d\/libssl/mu)
    assert.match(dockerfile, /^USER 65532:65532$/mu)
    const runtimeStage = dockerfile.slice(dockerfile.indexOf('FROM gcr.io/distroless/'))
    assert.doesNotMatch(runtimeStage, /\b(?:groupadd|useradd|apt-get|corepack|pnpm)\b/u)
    assert.doesNotMatch(dockerfile, /^COPY --from=build --chown=runlab:runlab \/app \/app$/mu)
  }
  for (const name of ['runtime-service', 'runtime-ingress-gateway']) {
    const dockerfile = readFileSync(join(import.meta.dirname, `../../deploy/private-cloud/images/Dockerfile.${name}`), 'utf8')
    assert.match(dockerfile, /pnpm deploy --legacy --filter @agent-kernel\/[^ ]+ --prod \/out\//u)
  }
  const dashboard = readFileSync(join(import.meta.dirname, '../../deploy/private-cloud/images/Dockerfile.dashboard'), 'utf8')
  assert.match(dashboard, /COPY --chown=root:root --chmod=644 deploy\/private-cloud\/images\/dashboard-server\.mjs \/app\/dashboard-server\.mjs/u, 'the non-root server must read its entrypoint even when the build context is owner-only')
})

test('Private Cloud scanner preserves failure while collecting all three image reports', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/private-cloud-release.yml'), 'utf8')
  for (const component of ['runtime', 'ingress', 'dashboard']) {
    assert.match(workflow, new RegExp(`scan ${component} [^\n]+ \\|\\| failed=1`, 'u'))
  }
  assert.match(workflow, /exit "\$failed"/u)
  assert.match(workflow, /grype "\$image"[^\n]+\|\| return 1/u)
  assert.match(workflow, /trivy image [^\n]+\|\| return 1/u)
})

test('Private Cloud release retains image publishing and accepts the exact signed Compose candidate', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/private-cloud-release.yml'), 'utf8')
  for (const image of ['runtime-image:', 'ingress-image:', 'dashboard-image:']) assert.ok(workflow.includes(image))
  const bundle = workflow.slice(workflow.indexOf('  bundle:'), workflow.indexOf('  fresh_beta_candidate_assets:'))
  assert.match(bundle, /setup-node@v5[\s\S]*node-version: 22[\s\S]*pnpm install --frozen-lockfile/u)
  assert.match(bundle, /build-private-cloud-operator\.mjs --target linux-x64 --output release\/kala-private-cloud-linux-x64[\s\S]*build-private-cloud-bundle\.mjs[\s\S]*--operator release\/kala-private-cloud-linux-x64/u)
  assert.match(workflow, /gh release view "\$TAG" --json isDraft --jq \.isDraft[\s\S]*gh release upload "\$TAG" "\$archive" "\$signature" --clobber/u)
  assert.match(workflow, /gh release download "\$TAG"[\s\S]*cmp "\$archive"[\s\S]*cmp "\$signature"/u)
  assert.match(workflow, /Transfer exact signed bundle[\s\S]*actions\/upload-artifact@v5[\s\S]*private-cloud-acceptance-input-/u)
  const staging = workflow.slice(workflow.indexOf('  fresh_beta_candidate_assets:'), workflow.indexOf('  fresh_beta_candidate_acceptance:'))
  assert.match(staging, /runs-on: ubuntu-latest[\s\S]*contents: write[\s\S]*gh release view "\$TAG" --json isDraft[\s\S]*gh release download "\$TAG"/u)
  assert.match(staging, /private-cloud-beta-draft-assets-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u)
  assert.doesNotMatch(staging, /PRIVATE_CLOUD_TEST_ALICE_PASSWORD/u)
  const fresh = workflow.slice(workflow.indexOf('  fresh_beta_candidate_acceptance:'), workflow.indexOf('  clean-compose-acceptance:'))
  assert.match(staging, /if: startsWith\(github\.ref, 'refs\/tags\/'\)/u)
  assert.match(fresh, /if: startsWith\(github\.ref, 'refs\/tags\/'\)/u)
  assert.doesNotMatch(staging + fresh, /v0\.3\.0-beta\.18/u, 'fresh install must apply to future release tags')
  assert.doesNotMatch(fresh, /KALA_PRIVATE_CLOUD_RUNNER_ENABLED/u)
  assert.match(fresh, /runs-on: ubuntu-24\.04/u)
  assert.match(fresh, /RUNNER_ENVIRONMENT: \$\{\{ runner\.environment \}\}[\s\S]*test "\$RUNNER_ENVIRONMENT" = github-hosted/u)
  assert.doesNotMatch(fresh, /\b(?:secrets|vars)\.|KALA_RC_PRIVATE_CLOUD_CONFIG_ARCHIVE_B64|PRIVATE_CLOUD_TEST_(?:ALICE|BOB)/u)
  assert.match(fresh, /Reserve disk for the signed candidate[\s\S]*available_kib >= 10485760/u)
  assert.match(fresh, /needs: \[resolve, bundle, fresh_beta_candidate_assets\][\s\S]*contents: read[\s\S]*actions: read/u)
  assert.match(fresh, /actions\/download-artifact@v5[\s\S]*private-cloud-beta-draft-assets-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u)
  assert.doesNotMatch(fresh, /contents: write|gh release download "\$TAG"/u)
  assert.match(fresh, /cosign verify-blob[\s\S]*while IFS= read -r image; do[\s\S]*cosign verify/u)
  assert.match(fresh, /--fresh-candidate --ephemeral-bundled-acceptance --candidate-archive/u)
  assert.doesNotMatch(fresh, /--predecessor-archive|--predecessor-revision/u)
  assert.match(fresh, /verify-private-cloud-fresh-evidence\.mjs/u)
  assert.match(fresh, /private-cloud-fresh-beta-evidence-/u)

  const acceptance = workflow.slice(workflow.indexOf('  clean-compose-acceptance:'))
  assert.match(acceptance, /needs: \[resolve, bundle, fresh_beta_candidate_acceptance, fresh_beta_candidate_assets\]/u)
  assert.match(acceptance, /if: always\(\)[^\n]*needs\.fresh_beta_candidate_acceptance\.result == 'success'/u)
  assert.doesNotMatch(acceptance, /v0\.3\.0-beta\.18|needs\.resolve\.outputs\.tag !=/u, 'optional upgrade cannot bypass fresh acceptance on later tags')
  assert.match(acceptance, /private-cloud-beta-draft-assets-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u)
  assert.match(acceptance, /runs-on: ubuntu-24\.04/u)
  assert.match(acceptance, /vars\.KALA_PRIVATE_CLOUD_UPGRADE_ACCEPTANCE_ENABLED == 'true'/u)
  assert.match(acceptance, /RUNNER_ENVIRONMENT: \$\{\{ runner\.environment \}\}[\s\S]*test "\$RUNNER_ENVIRONMENT" = github-hosted/u)
  assert.match(acceptance, /secrets\.KALA_RC_PRIVATE_CLOUD_CONFIG_ARCHIVE_B64[\s\S]*base64 -d \| tar -xz/u)
  assert.match(acceptance, /actions\/download-artifact@v5/u)
  assert.equal((acceptance.match(/cosign verify-blob/g) ?? []).length, 3)
  assert.match(acceptance, /git rev-parse "\$TAG\^\{commit\}"/u)
  assert.match(acceptance, /verify-private-cloud-clean-compose\.mjs[\s\S]*--non-certifying-predecessor[\s\S]*--candidate-archive[\s\S]*--predecessor-archive[\s\S]*--predecessor-tag[\s\S]*--predecessor-revision/u)
  assert.match(acceptance, /private-cloud-noncertifying-predecessor-evidence-/u)
  assert.match(acceptance, /e\.category!=="private-cloud-predecessor"[\s\S]*e\.certifying!==false/u)
  assert.doesNotMatch(acceptance, /fs\.writeFileSync/u)
})

test('release workflow publishes archived metadata and verifies the signed Executor-native inventory', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/release.yml'), 'utf8')
  assert.equal(workflow.match(/extract-release-metadata\.mjs release\/kala-release-metadata\.tar\.gz/g)?.length, 2)
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/tags\/\$TAG"/u)
  assert.match(workflow, /optional-host-native:[\s\S]*workflow_dispatch[\s\S]*--component host[\s\S]*name: optional-host-qualification-/u)
  assert.match(workflow, /native-assets:[\s\S]*--component executor[\s\S]*name: native-/u)
  assert.match(workflow, /test -f release\/kala-executor-service-host-win32-x64\.exe[\s\S]*-name 'kala-executor-\*' ! -name 'kala-executor-service-host-\*'[\s\S]*-eq 4/u)
  assert.match(workflow, /windows-assets:[\s\S]*runs-on: windows-latest[\s\S]*Require GNU tar and gzip from Git for Windows[\s\S]*--component all[\s\S]*--native-target win32-x64/u)
  assert.match(workflow, /TAR_OPTIONS=--force-local/u)
  assert.match(workflow, /windows-capture-manifest\.json[\s\S]*Windows capture checksum mismatch/u)
  assert.match(workflow, /subject-path: release\/\*/u)
  assert.match(workflow, /Verify exact signed Executor-native inventory[\s\S]*pnpm run verify:release-assets -- --require-signed/u)
  assert.match(workflow, /Verify exact signed Executor-native inventory[\s\S]*cosign verify-blob[\s\S]*certificate-oidc-issuer/u)
  assert.equal(workflow.match(/reconcile-github-release-assets\.mjs[^\n]+--preserve-private-cloud-assets/g)?.length, 2)
  const nativeRelease = workflow.slice(workflow.indexOf('  native-release:'))
  const captureValidation = nativeRelease.indexOf('Validate and stage the exact Windows-captured revision')
  const hostEmbedding = nativeRelease.indexOf('embed-windows-assets-in-portable-host.mjs')
  const finalize = nativeRelease.indexOf('--finalize-only')
  const installSmoke = nativeRelease.indexOf('pnpm run verify:release-install')
  const signing = nativeRelease.indexOf('cosign sign-blob')
  assert.ok(captureValidation >= 0 && captureValidation < hostEmbedding)
  assert.ok(hostEmbedding < finalize && finalize < installSmoke && installSmoke < signing)
  assert.match(nativeRelease, /embed-windows-assets-in-portable-host\.mjs[\s\S]*--repo \$\{\{ github\.repository \}\}[\s\S]*--tag \$\{\{ needs\.resolve\.outputs\.tag \}\}[\s\S]*--expected-revision \$\{\{ github\.sha \}\}/u)
  assert.doesNotMatch(workflow.slice(workflow.indexOf('  cjs-release:'), workflow.indexOf('  windows-assets:')), /embed-windows-assets-in-portable-host/u)
  assert.doesNotMatch(workflow, /notes-file release\/RELEASE_NOTES\.md/u)
  assert.doesNotMatch(workflow, /release\/sbom\.cdx\.json/u)
})

test('Portable OCI beta.19 dispatch requires immutable Node and isolated-VM acceptance', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/portable-image-release.yml'), 'utf8')
  assert.match(workflow, /ACCEPTED_TAG: v0\.3\.0-beta\.19/u)
  assert.doesNotMatch(workflow, /ACCEPTED_TAG: v0\.3\.0-beta\.18/u)
  assert.match(workflow, /node_22_amd64_digest:\n\s+description: [^\n]*digest[^\n]*sha256:\.\.\.\)\n\s+required: true\n\s+type: string/u)
  assert.match(workflow, /\[\[ "\$NODE_DIGEST" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/u)
  assert.match(workflow, /NODE_IMAGE=node:22-bookworm-slim@\$\{\{ inputs\.node_22_amd64_digest \}\}/u)
  assert.match(workflow, /require_isolated_vm_acceptance:\n\s+description: [^\n]+\n\s+required: true\n\s+type: boolean\n\s+default: true/u)
  assert.equal((workflow.match(/test "\$ACCEPTANCE_REQUIRED" = true/gu) ?? []).length, 2)
  assert.match(workflow, /test "\$ACCEPTANCE_RESULT" = success/u)
  assert.doesNotMatch(workflow, /isolated-VM acceptance not required/u)
})

test('RC promotion binds acceptance to the tag ref exposed by the Actions API', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/promote-rc.yml'), 'utf8')
  assert.doesNotMatch(workflow, /v0\.3\.0-beta\.18/u, 'fresh Private Cloud and OCI evidence must be verified for later tags too')
  assert.match(workflow, /Fresh beta candidate install and restore \(exact signed draft release\)[\s\S]*FRESH_RUN_ID/u)
  assert.match(workflow, /verify-private-cloud-fresh-evidence\.mjs[\s\S]*--archive "\$archive" --tag "\$TAG" --revision "\$REVISION"/u)
  assert.match(workflow, /--jq \.head_branch\)" = "\$TAG"/u)
  assert.doesNotMatch(workflow, /--jq \.inputs\.tag/u)
  assert.match(workflow, /verify-rc-evidence\.mjs[\s\S]*--tag "\$TAG" --revision/u)
  assert.match(workflow, /for target in linux-x64; do[\s\S]*cosign verify-blob[\s\S]*tar -xOzf "\$archive" \.\/manifest\.json[\s\S]*rm -- "\$archive" "\$signature"[\s\S]*verify-promotion-candidate\.mjs/u)
  assert.match(workflow, /kala-executor-win32-x64\.exe[\s\S]*node-pty-win32-x64\.tar\.gz kala-executor-service-host-win32-x64\.exe install-executor\.ps1/u)
  assert.doesNotMatch(workflow, /Windows release asset is not allowed/u)
  assert.match(workflow, /fresh_beta_candidate_acceptance|Fresh beta candidate install and restore \(exact signed draft release\)/u)
  assert.match(workflow, /portable-image-release\.yml\/runs[\s\S]*isolated-vm-acceptance/u)
  assert.match(workflow, /verify-private-cloud-fresh-evidence\.mjs[\s\S]*verify-portable-public\.mjs[\s\S]*if \[\[ "\$TAG" == \*-\* \]\]; then[\s\S]*gh release edit "\$TAG" --draft=false --prerelease[\s\S]*else[\s\S]*gh release edit "\$TAG" --draft=false/u)
  assert.match(workflow, /metadata\.sigstore\.json[\s\S]*portable-image-release\.yml@refs\/tags\/\$TAG/u)
  assert.match(workflow, /portable-isolated-vm-acceptance-\$PORTABLE_RUN_ID-\$PORTABLE_RUN_ATTEMPT/u)
  const portableWorkflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/portable-image-release.yml'), 'utf8')
  assert.match(portableWorkflow, /name: portable-isolated-vm-acceptance-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u)
  assert.match(workflow, /for component in runtime ingress dashboard; do[\s\S]*tar -xOzf "\$archive" \.\/image-lock\.json[\s\S]*DOCKER_CONFIG="\$anonymous_config" docker pull --quiet "\$image"/u)
  assert.match(workflow, /anonymous_docker_config=\$\(mktemp -d\)[\s\S]*DOCKER_CONFIG="\$anonymous_docker_config" docker pull "\$public_image"/u)
})

test('release reconciliation deletes unrelated remote assets and proves exact local closure', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'release-reconcile-'))
  try {
    const release = join(temporary, 'release')
    const bin = join(temporary, 'bin')
    mkdirSync(release)
    mkdirSync(bin)
    writeFileSync(join(release, 'manifest.json'), '{}\n')
    writeFileSync(join(release, 'SHA256SUMS'), 'sums\n')
    const state = join(temporary, 'assets.json')
    const log = join(temporary, 'gh.log')
    writeFileSync(state, JSON.stringify(['manifest.json', 'stale-debug.zip']))
    const fakeGh = join(bin, 'gh')
    writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); let assets = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'release' && args[1] === 'view') process.stdout.write(JSON.stringify({ assets: assets.map(name => ({ name })) }));
else if (args[0] === 'release' && args[1] === 'delete-asset') assets = assets.filter(name => name !== args[3]);
else if (args[0] === 'release' && args[1] === 'upload') for (const file of args.slice(3, -1)) { const name = path.basename(file); if (!assets.includes(name)) assets.push(name); }
else process.exit(2);
fs.writeFileSync(process.env.GH_STATE, JSON.stringify(assets));
`)
    chmodSync(fakeGh, 0o755)
    const result = spawnSync(process.execPath, [reconcile, '--tag', 'v1.2.3-rc.1', '--directory', release], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_STATE: state, GH_LOG: log },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')).sort(), ['SHA256SUMS', 'manifest.json'])
    assert.match(readFileSync(log, 'utf8'), /delete-asset.*stale-debug\.zip/u)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

test('promotion verifier binds the closed current draft to four accepted Portable records and exact Windows hashes', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'promotion-candidate-'))
  try {
    const candidate = join(temporary, 'candidate')
    const evidence = join(temporary, 'evidence')
    mkdirSync(candidate)
    mkdirSync(evidence)
    const tag = 'v1.2.3-rc.1'
    const revision = 'a'.repeat(40)
    const targets = [...requiredReleaseEvidence.portable.targets]
    const nativeAssets = targets.map((target) => target === 'win32-x64' ? 'kala-executor-win32-x64.exe' : `kala-executor-${target}`)
    const windowsAssets = ['node-pty-win32-x64.tar.gz', 'kala-executor-service-host-win32-x64.exe', 'install-executor.ps1']
    const assets = [
      ...nativeAssets,
      ...windowsAssets,
      ...targets.flatMap((target) => [`kala-copilot-runtime-${target}`, `kala-copilot-runtime-node-${target}.node`]),
      'kala-dashboard-with-runtime.cjs', 'kala-runtime.cjs', 'kala-executor.cjs', 'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs',
      'kala-dashboard.tar.gz', 'kala-docs.tar.gz', 'kala-dedicated-support.tar.gz', 'kala-release-metadata.tar.gz',
      'run.sh', 'kala-dedicated.mjs', 'kala-model-catalog-seed.json',
    ]
    for (const [index, name] of assets.entries()) writeFileSync(join(candidate, name), `asset-${index}\n`)
    const nativeInventory = {
      'kala-host': [], 'kala-runtime': [], 'kala-executor': nativeAssets,
      'kala-dedicated-ingress': [], 'kala-dedicated-deploy-supervisor': [],
    }
    writeFileSync(join(candidate, 'manifest.json'), JSON.stringify({ version: tag.slice(1), source: { revision }, nativeTargets: targets, nativeAssets: nativeInventory, windowsServiceHost: windowsServiceHostManifestMetadata(), assets }, null, 2) + '\n')
    writeFileSync(join(candidate, 'SHA256SUMS.sigstore.json'), '{}\n')
    const aggregate = join(temporary, 'rc-evidence.json')
    writeFileSync(aggregate, '{"ok":true}\n')
    writeChecksums(candidate, [...assets, 'manifest.json'])
    for (const target of targets) {
      const name = 'kala-dashboard-with-runtime.cjs'
      const windowsNames = [name, 'kala-executor-win32-x64.exe', 'node-pty-win32-x64.tar.gz', 'kala-executor-service-host-win32-x64.exe', 'install-executor.ps1', 'kala-copilot-runtime-win32-x64', 'kala-copilot-runtime-node-win32-x64.node']
      const checkNames = requiredReleaseEvidence.portable.targetChecks?.[target] ?? requiredReleaseEvidence.portable.checks
      const checks = Object.fromEntries(checkNames.map((check) => [check, true]))
      writeFileSync(join(evidence, `${target}.rc-evidence.json`), JSON.stringify({
        schemaVersion: 1, category: 'portable', tag, version: tag.slice(1), revision, target,
        artifact: { name, sha256: digest(readFileSync(join(candidate, name))) },
        ...(target === 'win32-x64' ? { artifacts: windowsNames.map((assetName) => ({ name: assetName, sha256: digest(readFileSync(join(candidate, assetName))) })) } : {}),
        ok: true, checks, generatedAt: '2026-01-01T00:00:00.000Z',
      }))
    }
    const args = [verifyPromotion, '--directory', candidate, '--evidence', evidence, '--aggregate', aggregate, '--tag', tag, '--revision', revision]
    assert.equal(spawnSync(process.execPath, args, { encoding: 'utf8' }).status, 0)

    writeFileSync(join(candidate, 'stale-debug.zip'), 'stale')
    let result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /inventory is not closed/u)
    unlinkSync(join(candidate, 'stale-debug.zip'))

    writeFileSync(join(candidate, 'kala-dashboard-with-runtime.cjs'), 'replaced-after-acceptance\n')
    writeChecksums(candidate, [...assets, 'manifest.json'])
    result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /differs from its validated acceptance evidence/u)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
})

function writeChecksums(directory, names) {
  writeFileSync(join(directory, 'SHA256SUMS'), names.map((name) => `${digest(readFileSync(join(directory, name)))}  ${name}`).join('\n') + '\n')
}
