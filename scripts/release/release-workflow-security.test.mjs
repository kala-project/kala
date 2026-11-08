import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { requiredReleaseEvidence } from './rc-evidence.mjs'
import { windowsServiceHostManifestMetadata } from './windows-service-host.mjs'
import { POSIX_PORTABLE_MANAGER, WINDOWS_PORTABLE_MANAGER } from './portable-manager.mjs'
import { signExecutorUpdateFeed, UPDATE_FEED_FILES, executorProtocolMajor } from './executor-update-feed.mjs'

const reconcile = join(import.meta.dirname, 'reconcile-github-release-assets.mjs')
const verifyPromotion = join(import.meta.dirname, 'verify-promotion-candidate.mjs')
const digest = (value) => createHash('sha256').update(value).digest('hex')

test('all release gates use official verified cosign sources and fail closed', () => {
  const action = readFileSync(join(import.meta.dirname, '../../.github/actions/install-verified-cosign/action.yml'), 'utf8')
  assert.equal((action.match(/uses: sigstore\/cosign-installer@v3/gu) ?? []).length, 3)
  assert.equal((action.match(/continue-on-error: true/gu) ?? []).length, 3)
  assert.match(action, /if: steps\.first\.outcome == 'failure'\n\s+shell: bash\n\s+run: sleep 15/u)
  assert.match(action, /if: steps\.first\.outcome == 'failure' && steps\.second\.outcome == 'failure'\n\s+shell: bash\n\s+run: sleep 45/u)
  assert.match(action, /id: third\n\s+if: steps\.first\.outcome == 'failure' && steps\.second\.outcome == 'failure'\n\s+uses: sigstore\/cosign-installer@v3\n\s+continue-on-error: true/u)
  assert.match(action, /if: steps\.third\.outcome == 'failure'\n\s+shell: bash\n\s+run: \|[\s\S]*?image=ghcr\.io\/sigstore\/cosign\/cosign@sha256:cd934061aabb2b7715558adb1ad192d569d355f2ad1f56202b028adaa30a690c/u)
  assert.match(action, /docker pull --platform linux\/amd64 "\$image"[\s\S]*?docker image inspect --format '[^']+'[\s\S]*?docker cp "\$container:\/ko-app\/cosign"[\s\S]*?"\$HOME\/\.cosign\/cosign" version \| grep -F 'v2\.5\.2'/u)
  for (const name of ['release', 'private-cloud-release', 'rc-acceptance', 'promote-rc', 'portable-image-release']) {
    const workflow = readFileSync(join(import.meta.dirname, `../../.github/workflows/${name}.yml`), 'utf8')
    assert.match(workflow, /uses: \.\/\.github\/actions\/install-verified-cosign/u)
    assert.doesNotMatch(workflow, /uses: sigstore\/cosign-installer@v3/u)
  }
})

test('tag orchestrator promotes only after exact-revision asset, image, and hosted acceptance gates', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/release-orchestrator.yml'), 'utf8')
  assert.match(workflow, /tags: \['v0\.4\.0', 'v0\.4\.1', 'v0\.4\.2'\]/u)
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/tags\/\$TAG"/u)
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$\(git rev-parse "\$TAG\^\{commit\}"\)"/u)
  assert.match(workflow, /group: complete-release-\$\{\{ github\.sha \}\}/u)
  assert.match(workflow, /test "\$\(gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/tags\/\$TAG" --jq \.object\.sha\)" = "\$\(git rev-parse "refs\/tags\/\$TAG"\)"/u)
  assert.match(workflow, /for \(\(attempt=0; attempt<660; attempt\+\+\)\); do\n\s+require_current_tag \|\| return 1/u)
  assert.match(workflow, /require_current_tag\n\s+gh workflow run (?:rc-acceptance|promote-rc)\.yml/gu)
  assert.match(workflow, /jq -c --arg revision "\$revision" --arg tag "\$TAG" --argjson minimum "\$minimum"[\s\S]*\.head_sha == \$revision and \.head_branch == \$tag and \.id > \$minimum/u)
  const stages = [
    'wait_for_run release.yml push 0',
    'wait_for_run private-cloud-release.yml push 0',
    'gh workflow run rc-acceptance.yml',
    'gh workflow run portable-image-release.yml',
    'wait_for_run rc-acceptance.yml workflow_dispatch',
    'wait_for_run portable-image-release.yml workflow_dispatch',
    'gh workflow run promote-rc.yml',
    'wait_for_run promote-rc.yml workflow_dispatch',
  ]
  for (let index = 1; index < stages.length; index++) {
    assert.ok(workflow.indexOf(stages[index - 1]) < workflow.indexOf(stages[index]), `${stages[index]} must follow its gate`)
  }
  assert.match(workflow, /test "\$conclusion" = success \|\|/u)
  assert.match(workflow, /-F require_isolated_vm_acceptance=true/u)
  assert.match(workflow, /promote_before="\$\(baseline promote-rc\.yml\)"[\s\S]*wait_for_run promote-rc\.yml workflow_dispatch "\$promote_before"/u)
  assert.match(workflow, /test "\$\(gh release view "\$TAG" --json isDraft --jq \.isDraft\)" = false/u)
})

test('release and RC retries are bounded to unassigned macOS runners and never hide failures', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/release-orchestrator.yml'), 'utf8')
  const predicate = workflow.match(/if jq -e '([\s\S]*?)' <<< "\$jobs" >\/dev\/null/u)?.[1]
  assert.ok(predicate)
  assert.match(workflow, /"\$workflow" == rc-acceptance\.yml \|\| "\$workflow" == release\.yml/u)
  assert.match(workflow, /"\$retries" -lt 2/u)
  assert.match(workflow, /gh run rerun "\$run_id" --failed/u)
  const job = (name, conclusion, runnerId = 123) => ({
    name, conclusion, runner_id: runnerId, runner_name: runnerId ? 'GitHub Actions' : '', steps: [],
    labels: name === 'darwin-arm64' ? ['macos-15'] : name === 'darwin-x64' ? ['macos-15-intel'] : ['ubuntu-24.04'],
  })
  const passes = (jobs) => spawnSync('jq', ['-e', predicate], {
    encoding: 'utf8', input: JSON.stringify({ total_count: jobs.length, jobs }),
  }).status === 0
  assert.equal(passes([job('linux-x64', 'success'), job('darwin-arm64', 'cancelled', null)]), true)
  assert.equal(passes([job('linux-x64', 'success'), job('darwin-arm64', 'cancelled', 0), job('darwin-x64', 'cancelled', 0)]), true)
  assert.equal(passes([job('linux-x64', 'failure'), job('darwin-arm64', 'cancelled', null)]), false)
  assert.equal(passes([job('linux-x64', 'success'), job('darwin-arm64', 'cancelled', 123)]), false)
  assert.equal(passes([job('linux-x64', 'success'), { ...job('darwin-arm64', 'cancelled', 0), runner_name: 'mac runner' }]), false)
  assert.equal(passes([job('linux-x64', 'success'), { ...job('darwin-arm64', 'cancelled', 0), steps: [{ name: 'Checkout' }] }]), false)
  assert.equal(passes([job('linux-x64', 'success'), job('darwin-arm64', 'cancelled', null), job('windows', 'cancelled', null)]), false)
  const unsettledPredicate = workflow.match(/if \[\[ "\$unsettled" -lt 4 \]\] && jq -e '([\s\S]*?)' <<< "\$jobs" >\/dev\/null/u)?.[1]
  assert.ok(unsettledPredicate)
  const pending = (jobs, totalCount = jobs.length) => spawnSync('jq', ['-e', unsettledPredicate], {
    encoding: 'utf8', input: JSON.stringify({ total_count: totalCount, jobs }),
  }).status === 0
  assert.equal(pending([job('darwin-arm64', null, 0), job('linux-x64', 'success')]), true)
  assert.equal(pending([job('darwin-arm64', 'cancelled', 0)], 2), true)
  assert.equal(pending([job('darwin-arm64', 'cancelled', 0), job('linux-x64', 'failure')], 3), false)
  assert.equal(pending([job('darwin-arm64', 'cancelled', 0), job('linux-x64', 'success')]), false)
})

test('Windows acceptance builds real workspace dependencies instead of a quoted empty pnpm filter', () => {
  const scripts = JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')).scripts
  for (const name of ['build', 'typecheck']) {
    assert.match(scripts[name], /pnpm -r --filter=!@agent-kernel\/desktop run build/u)
    assert.doesNotMatch(scripts[name], /--filter ['"]!@agent-kernel\/desktop['"]/u)
  }
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/rc-acceptance.yml'), 'utf8')
  assert.match(workflow, /windows-portable-conpty:[\s\S]*pnpm --filter @agent-kernel\/shared\.\.\. run build[\s\S]*Prove Windows Node\.js 22 Host/u)
  assert.match(workflow, /\$assets = @\([\s\S]*?'install-executor\.ps1'\s*\)/u)
})

test('Private Cloud Windows invite fixture uses the same OIDC authentication contract as the Gateway', () => {
  const fixture = readFileSync(join(import.meta.dirname, '../product-e2e/verify-private-cloud-windows-invite.mjs'), 'utf8')
  assert.match(fixture, /authentication: \{\s*kind: 'oidc',\s*loginStates: new MemoryLoginStates\(\),\s*secretBox: createSessionSecretBox\([\s\S]*oidc: \{/u)
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

  for (const asset of ['kala-executor-service-host-win32-x64.exe', 'node-pty-win32-x64.tar.gz']) {
    assert.match(dockerfile, new RegExp(`cp /tmp/windows-assets/${asset.replaceAll('.', '\\.')} release/`, 'u'))
  }
  assert.match(dockerfile, /chmod \+x release\/kala-executor-service-host-win32-x64\.exe/u)
  assert.match(dockerfile, /embed-windows-assets-in-portable-host\.mjs[\s\S]*--finalize-only[\s\S]*pnpm run verify:release-assets -- --private-cloud-runtime/u)
  const verifier = readFileSync(join(import.meta.dirname, 'verify-release-assets.mjs'), 'utf8')
  assert.match(verifier, /privateCloudRuntime = process\.argv\.includes\('--private-cloud-runtime'\)/u)
  assert.match(verifier, /JSON\.stringify\(actualNativeTargets\) !== '\[\]'/u)
  assert.match(verifier, /standalone native Executor binaries are not release assets/u)
  assert.match(dockerfile, /COPY --from=build --chown=65532:65532 \/app\/release\/ \/app\/release\//u)
})

test('Platform images keep the matched Copilot executable outside noexec tenant scratch', () => {
  const sdkVersion = JSON.parse(readFileSync(join(import.meta.dirname, '../../packages/host/package.json'), 'utf8')).dependencies['@github/copilot-sdk']
  const sdkPrebuild = `/app/node_modules/.pnpm/@github+copilot-sdk-linux-x64@${sdkVersion}/node_modules/@github/copilot-sdk-linux-x64/prebuilds/linux-x64/`
  for (const path of ['deploy/private-cloud/images/Dockerfile.runtime-service', 'deploy/aspire/Dockerfile.runtime-linux-e2e']) {
    const dockerfile = readFileSync(join(import.meta.dirname, '../..', path), 'utf8')
    assert.ok(dockerfile.includes(`COPY --from=build --chown=root:root --chmod=0555 ${sdkPrebuild}copilot-runtime /app/copilot-runtime/copilot-runtime`))
    assert.ok(dockerfile.includes(`COPY --from=build --chown=root:root --chmod=0444 ${sdkPrebuild}runtime.node /app/copilot-runtime/runtime.node`))
    assert.doesNotMatch(dockerfile, /COPY --from=build [^\n]*\/app\/release\/kala-copilot-runtime-/u)
    assert.match(dockerfile, /^ENV COPILOT_CLI_PATH=\/app\/copilot-runtime\/copilot-runtime$/mu)
  }
  for (const path of ['compose.storage-postgres-s3.yaml', 'compose.storage-postgres-s3.parallel.yaml']) {
    const compose = readFileSync(join(import.meta.dirname, '../../deploy/private-cloud', path), 'utf8')
    assert.match(compose, /\/var\/lib\/kala:rw,noexec,nosuid,size=256m/u)
  }
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
  const runtimeDigest = 'sha256:5e72a679e328276f6ffc3c4bb45c94f847f6abf0b424a1f8cc984f7f1c1daf47'
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
    assert.doesNotMatch(runtimeStage, /^RUN\b/mu)
    assert.doesNotMatch(runtimeStage, /^COPY .*\/(?:bin|sbin)\/(?:groupadd|useradd|apt-get|corepack|pnpm)(?:\s|$)/mu)
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
  assert.match(fresh, /--fresh-candidate --candidate-archive/u)
  assert.doesNotMatch(fresh, /--ephemeral-bundled-acceptance/u)
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

test('release workflow publishes archived metadata and verifies the signed CJS Executor inventory', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/release.yml'), 'utf8')
  assert.equal(workflow.match(/extract-release-metadata\.mjs release\/kala-release-metadata\.tar\.gz/g)?.length, 2)
  assert.match(workflow, /pnpm run test:extended\n\s+- run: KALA_RUN_POSTGRES_INTEGRATION=1 pnpm --dir packages\/host exec vitest run src\/store\/postgres-session\.integration\.test\.ts/u)
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/tags\/\$TAG"/u)
  assert.match(workflow, /optional-host-native:[\s\S]*workflow_dispatch[\s\S]*--component host[\s\S]*name: optional-host-qualification-/u)
  assert.doesNotMatch(workflow, /^  native-assets:/mu)
  assert.match(workflow, /test -f release\/kala-executor\.cjs[\s\S]*test -f release\/kala-executor-service-host-win32-x64\.exe[\s\S]*-name 'kala-executor-win32-\*\.exe'/u)
  assert.match(workflow, /windows-assets:[\s\S]*runs-on: windows-latest[\s\S]*Require GNU tar and gzip from Git for Windows[\s\S]*--component all[\s\S]*--native-target win32-x64/u)
  assert.match(workflow, /Build the platform-neutral Portable Host on Windows Node\.js 22[\s\S]*node --test scripts\/release\/portable-manager-windows\.test\.mjs[\s\S]*Capture the Windows-built Host/u)
  assert.match(workflow, /TAR_OPTIONS=--force-local/u)
  assert.match(workflow, /windows-capture-manifest\.json[\s\S]*Windows capture checksum mismatch/u)
  assert.match(workflow, /subject-path: release\/\*/u)
  assert.match(workflow, /Verify exact signed CJS Executor inventory[\s\S]*pnpm run verify:release-assets -- --require-signed/u)
  assert.match(workflow, /Verify exact signed CJS Executor inventory[\s\S]*cosign verify-blob[\s\S]*certificate-oidc-issuer/u)
  assert.equal(workflow.match(/reconcile-github-release-assets\.mjs[^\n]+--preserve-private-cloud-assets/g)?.length, 2)
  const nativeRelease = workflow.slice(workflow.indexOf('  native-release:'))
  const captureValidation = nativeRelease.indexOf('Validate and stage the exact Windows-captured revision')
  const feedSigning = nativeRelease.indexOf('stage-signed-executor-update-feed.mjs')
  const hostEmbedding = nativeRelease.indexOf('embed-windows-assets-in-portable-host.mjs')
  const finalize = nativeRelease.indexOf('--finalize-only')
  const installSmoke = nativeRelease.indexOf('pnpm run verify:release-install')
  const signing = nativeRelease.indexOf('cosign sign-blob')
  assert.ok(captureValidation >= 0 && captureValidation < feedSigning && feedSigning < hostEmbedding)
  assert.doesNotMatch(nativeRelease, /EXECUTOR_UPDATE_PRIVATE_KEY_PEM/u)
  assert.match(nativeRelease, /stage-signed-executor-update-feed\.mjs[\s\S]*--tag \$\{\{ needs\.resolve\.outputs\.tag \}\}[\s\S]*embed-windows-assets-in-portable-host\.mjs[\s\S]*--finalize-only[\s\S]*--require-signed/u)
  assert.match(readFileSync(join(import.meta.dirname, '../../.github/workflows/promote-rc.yml'), 'utf8'), /verify-promotion-candidate\.mjs[\s\S]*executor-update-manifest\.json executor-update-public-key\.pem/u)
  assert.ok(hostEmbedding < finalize && finalize < installSmoke && installSmoke < signing)
  assert.match(nativeRelease, /embed-windows-assets-in-portable-host\.mjs[\s\S]*--repo \$\{\{ github\.repository \}\}[\s\S]*--tag \$\{\{ needs\.resolve\.outputs\.tag \}\}[\s\S]*--expected-revision \$\{\{ github\.sha \}\}/u)
  assert.doesNotMatch(workflow.slice(workflow.indexOf('  cjs-release:'), workflow.indexOf('  windows-assets:')), /embed-windows-assets-in-portable-host/u)
  assert.doesNotMatch(workflow, /notes-file release\/RELEASE_NOTES\.md/u)
  assert.doesNotMatch(workflow, /release\/sbom\.cdx\.json/u)
})

test('Portable OCI dispatch binds the exact tag and requires immutable Node and isolated-VM acceptance', () => {
  const workflow = readFileSync(join(import.meta.dirname, '../../.github/workflows/portable-image-release.yml'), 'utf8')
  assert.doesNotMatch(workflow, /ACCEPTED_TAG:/u)
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/tags\/\$TAG"/u)
  assert.match(workflow, /git rev-parse "\$TAG\^\{commit\}"\)" = "\$REVISION"/u)
  assert.match(workflow, /GITHUB_WORKFLOW_REF" = "\$GITHUB_REPOSITORY\/\.github\/workflows\/portable-image-release\.yml@refs\/tags\/\$TAG"/u)
  assert.match(workflow, /node_22_amd64_digest:\n\s+description: [^\n]*digest[^\n]*sha256:\.\.\.\)\n\s+required: true\n\s+type: string/u)
  assert.match(workflow, /\[\[ "\$NODE_DIGEST" =~ \^sha256:\[0-9a-f\]\{64\}\$ \]\]/u)
  assert.match(workflow, /NODE_IMAGE=node:22-bookworm-slim@\$\{\{ inputs\.node_22_amd64_digest \}\}/u)
  assert.match(workflow, /if curl -sSfL --retry 3 -o \/tmp\/syft\.tar\.gz[\s\S]*?echo "\$\{SYFT_SHA256\}  \/tmp\/syft\.tar\.gz" \| sha256sum -c -[\s\S]*?else\n\s+image=ghcr\.io\/anchore\/syft@sha256:10959a01773b3b2e5ce9fb3f33b6accf5091ebdd62a8f3c255b2e0b43d2aa03a/u)
  assert.match(workflow, /docker pull --platform linux\/amd64 "\$image"[\s\S]*?docker image inspect --format '[^']+'[\s\S]*?docker cp "\$container:\/syft" \/usr\/local\/bin\/syft[\s\S]*?syft version \| grep -F "\$\{SYFT_VERSION#v\}"/u)
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
  assert.match(workflow, /kala-executor\.cjs[\s\S]*node-pty-win32-x64\.tar\.gz kala-executor-service-host-win32-x64\.exe install-executor\.ps1/u)
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
  const temporary = mkdtempSync(join(import.meta.dirname, '.promotion-candidate-'))
  try {
    const candidate = join(temporary, 'candidate')
    const evidence = join(temporary, 'evidence')
    mkdirSync(candidate)
    mkdirSync(evidence)
    const tag = 'v1.2.3-rc.1'
    const revision = 'a'.repeat(40)
    const targets = [...requiredReleaseEvidence.portable.targets]
    const windowsAssets = ['node-pty-win32-x64.tar.gz', 'kala-executor-service-host-win32-x64.exe', 'install-executor.ps1']
    const assets = [
      ...windowsAssets,
      'kala-dashboard-with-runtime.cjs', 'kala-runtime.cjs', 'kala-executor.cjs', 'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs',
      'kala-dashboard.tar.gz', 'kala-docs.tar.gz', 'kala-dedicated-support.tar.gz', 'kala-release-metadata.tar.gz',
      'run.sh', POSIX_PORTABLE_MANAGER, WINDOWS_PORTABLE_MANAGER, 'kala-dedicated.mjs', 'kala-model-catalog-seed.json',
    ]
    for (const [index, name] of assets.entries()) writeFileSync(join(candidate, name), `asset-${index}\n`)
    const nativeInventory = {
      'kala-host': [], 'kala-runtime': [], 'kala-executor': [],
      'kala-dedicated-ingress': [], 'kala-dedicated-deploy-supervisor': [],
    }
    writeFileSync(join(candidate, 'manifest.json'), JSON.stringify({ repo: 'example/kala', component: 'all', tag, version: tag.slice(1), source: { revision }, nativeTargets: [], nativeAssets: nativeInventory, windowsServiceHost: windowsServiceHostManifestMetadata(), assets }, null, 2) + '\n')
    const keyFile = join(temporary, 'operator.pem')
    writeFileSync(keyFile, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }))
    signExecutorUpdateFeed(candidate, keyFile, executorProtocolMajor())
    assets.push(...UPDATE_FEED_FILES)
    writeFileSync(join(candidate, 'SHA256SUMS.sigstore.json'), '{}\n')
    const aggregate = join(temporary, 'rc-evidence.json')
    writeFileSync(aggregate, '{"ok":true}\n')
    writeChecksums(candidate, [...assets, 'manifest.json'])
    for (const target of targets) {
      const name = 'kala-dashboard-with-runtime.cjs'
      const windowsNames = [name, 'kala-executor.cjs', 'node-pty-win32-x64.tar.gz', 'kala-executor-service-host-win32-x64.exe', 'install-executor.ps1']
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
    let result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)

    const manifestPath = join(candidate, 'manifest.json')
    const originalManifest = readFileSync(manifestPath, 'utf8')
    const feedPath = join(candidate, UPDATE_FEED_FILES[0])
    const originalFeed = readFileSync(feedPath)
    unlinkSync(feedPath)
    result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(result.status, 0, 'promotion must require the signed feed file')
    writeFileSync(feedPath, originalFeed)
    const tamperedFeed = JSON.parse(originalFeed)
    tamperedFeed.signature = tamperedFeed.signature.replace(/^./u, tamperedFeed.signature.startsWith('A') ? 'B' : 'A')
    writeFileSync(feedPath, JSON.stringify(tamperedFeed))
    writeChecksums(candidate, [...assets, 'manifest.json'])
    result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(result.status, 0, 'promotion must reject a tampered feed even with refreshed checksums')
    assert.match(result.stderr, /signature verification failed/u)
    writeFileSync(feedPath, originalFeed)
    writeChecksums(candidate, [...assets, 'manifest.json'])
    for (const manager of [POSIX_PORTABLE_MANAGER, WINDOWS_PORTABLE_MANAGER]) {
      const manifest = JSON.parse(originalManifest)
      manifest.assets = assets.filter((name) => name !== manager)
      writeFileSync(manifestPath, JSON.stringify(manifest) + '\n')
      writeChecksums(candidate, [...assets, 'manifest.json'])
      result = spawnSync(process.execPath, args, { encoding: 'utf8' })
      assert.notEqual(result.status, 0, `promotion must require ${manager} in the manifest`)
      assert.match(result.stderr, /exact checksummed assets/u)
      writeFileSync(manifestPath, originalManifest)
      writeChecksums(candidate, [...assets, 'manifest.json'])

      const path = join(candidate, manager)
      const bytes = readFileSync(path)
      unlinkSync(path)
      result = spawnSync(process.execPath, args, { encoding: 'utf8' })
      assert.notEqual(result.status, 0, `promotion must require the ${manager} file`)
      assert.match(result.stderr, /inventory is not closed/u)
      writeFileSync(path, bytes)
    }

    writeFileSync(join(candidate, 'stale-debug.zip'), 'stale')
    result = spawnSync(process.execPath, args, { encoding: 'utf8' })
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
