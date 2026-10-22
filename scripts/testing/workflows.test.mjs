import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { parse as parseYaml } from '../../node_modules/.pnpm/node_modules/yaml/dist/index.js'

const root = resolve(import.meta.dirname, '../..')
const workflow = async (name) => await readFile(resolve(root, '.github/workflows', name), 'utf8')
const workflowDocument = async (name) => parseYaml(await workflow(name))
const namedStep = (job, name) => job.steps.find((step) => step.name === name)

const automaticEvents = (source) => source.match(/^on:\n([\s\S]*?)\n(?:permissions|concurrency|jobs):/mu)?.[1] ?? ''

test('PR workflow contains only fast typecheck, unit, boundary, and static gates', async () => {
  const source = await workflow('ci.yml')
  assert.match(source, /pull_request:/u)
  assert.match(source, /pnpm run ci:fast/u)
  assert.match(source, /git cat-file -e "\$BEFORE\^\{commit\}"/u)
  assert.match(source, /privacy-check\.mjs --range "\$AFTER"/u)
  for (const expensive of ['ci:browser', 'ci:sandbox-acceptance', 'ci:release-acceptance', 'evaluation:run-real']) assert.doesNotMatch(source, new RegExp(expensive, 'u'))
})

test('integration, browser/security, and container acceptance are separate layers', async () => {
  assert.match(await workflow('integration.yml'), /ci:integration/u)
  const browserSecurity = await workflow('browser-security.yml')
  assert.match(browserSecurity, /layer: \[browser, security\]/u)
  const system = await workflow('product-system-e2e.yml')
  assert.equal((system.match(/build:release-assets -- --tag latest --repo xingsy97\/kala/gu) ?? []).length, 2)
  assert.match(system, /KALA_LXD_RUNNER_ENABLED == 'true'/u)
  const acceptance = await workflow('container-acceptance.yml')
  assert.match(acceptance, /layer: \[sandbox-acceptance, release-acceptance\]/u)
  assert.doesNotMatch(automaticEvents(acceptance), /pull_request:/u)
})

test('real model and benchmark subset workflow is manual or scheduled and containerized', async () => {
  const source = await workflow('real-model-evaluation.yml')
  const events = automaticEvents(source)
  assert.match(events, /workflow_dispatch:/u)
  assert.match(events, /schedule:/u)
  assert.doesNotMatch(events, /(?:pull_request|push):/u)
  assert.match(source, /^    container:\n      image: /mu)
  assert.match(source, /evaluation:run-real-task-pack/u)
  assert.match(source, /evaluation:run-real-swe-bench/u)
})

test('verification fixtures use ephemeral scoped auth without anonymous fallback', async () => {
  const fixture = await readFile(resolve(root, 'scripts/evaluation/fixtures/ephemeral-auth.mjs'), 'utf8')
  assert.match(fixture, /randomBytes/u)
  assert.match(fixture, /BearerTokenAuthenticator/u)
  for (const role of ['operator', 'worker', 'analyzer']) assert.match(fixture, new RegExp("'" + role + "'", 'u'))
  for (const name of ['run-real-task-pack.mjs', 'run-real-swe-bench.mjs', 'verify-remaining-benchmark-lifecycles.mjs']) {
    const source = await readFile(resolve(root, 'scripts/evaluation', name), 'utf8')
    assert.match(source, /createEphemeralAuth/u)
    assert.match(source, /createEvaluationHttpServer\(controlPlane, \{ authenticator: auth\.authenticator \}\)/u)
    assert.doesNotMatch(source, /createEvaluationHttpServer\(controlPlane\)\s*$/mu)
  }
})

test('security and release workflows fail closed without automatic npm publishing', async () => {
  const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  assert.match(rootPackage.scripts['ci:security'], /verify:supply-chain -- --strict/u)

  const security = await workflow('browser-security.yml')
  for (const scanner of ['SYFT_VERSION', 'GRYPE_VERSION', 'TRIVY_VERSION', 'COSIGN_VERSION']) assert.match(security, new RegExp(`${scanner}: v\\d`, 'u'))
  assert.match(security, /pnpm run ci:security/u)
  assert.match(security, /browser-actions\/setup-chrome@v2/u)
  assert.match(security, /CHROME_PATH: \$\{\{ steps\.chrome\.outputs\.chrome-path \}\}/u)
  assert.ok(security.indexOf('build:release-assets -- --tag latest') < security.indexOf('pnpm run ci:security'))
  assert.match(security, /syft dir:release/u)
  assert.match(security, /extract-release-metadata\.mjs release\/kala-release-metadata\.tar\.gz/u)
  assert.match(security, /grype sbom:"\$metadata\/sbom\.cdx\.json"/u)
  assert.match(security, /trivy fs --scanners vuln/u)
  assert.match(security, /trivy sbom --scanners vuln/u)
  assert.doesNotMatch(security, /syft dir:\./u)
  assert.match(security, /check-vulnerabilities\.mjs/u)

  await assert.rejects(workflow('publish.yml'), { code: 'ENOENT' })
  const publisher = await readFile(resolve(root, 'scripts/release/publish-workspaces.mjs'), 'utf8')
  assert.match(publisher, /['view', identity, 'version', '--json']/u)
  assert.match(publisher, /E404|is not in this registry/u)
  assert.match(publisher, /registry lookup failed/u)

  const release = await workflow('release.yml')
  assert.match(release, /gh release create[\s\S]*?--draft/u)
  assert.doesNotMatch(release, /gh release edit "\$TAG" --draft=false/u)
  assert.match(release, /gh release edit "\$TAG" --draft/u)
  assert.match(release, /verify:public-packages/u)
  assert.match(release, /default: 'linux-x64,darwin-x64,darwin-arm64,win32-x64'/u)
  assert.match(release, /if \[ "\$NATIVE_TARGETS" != "\$REQUIRED_NATIVE_TARGETS" \]/u)
  assert.match(release, /partial four-platform releases are not supported/u)
  assert.doesNotMatch(release, /startsWith\(matrix\.target, 'win32-'/u)
  assert.match(release, /Real Windows API created\.command temporary install and Host session gate[\s\S]*?verify-windows-terminal\.mjs/u)
  assert.match(release, /Real Windows API created\.command service install and Host session gate[\s\S]*?PRODUCT_E2E_WINDOWS_SERVICE: '1'/u)
  assert.ok(release.indexOf('Real Windows API created.command service install and Host session gate') < release.indexOf('name: windows-captured-assets'))
  assert.equal((release.match(/reconcile-github-release-assets\.mjs/gu) ?? []).length, 2)
  assert.doesNotMatch(release, /gh release upload "\$TAG" release\/\* --clobber/u)
  assert.doesNotMatch(release, /npm publish/u)
  const windows = await workflow('product-system-e2e.yml')
  assert.match(windows, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Windows release asset verification failed' \}/u)
  assert.match(windows, /Real Windows API created\.command temporary Terminal lifecycle and invite\.ps1 security preflight/u)
  assert.match(windows, /Real Windows service Terminal lifecycle E2E[\s\S]*?PRODUCT_E2E_WINDOWS_SERVICE: '1'/u)
  const terminal = await readFile(resolve(root, 'scripts/product-e2e/verify-windows-terminal.mjs'), 'utf8')
  assert.match(terminal, /\[Console\]::IsOutputRedirected/u)
  assert.match(terminal, /redirected pipes instead of ConPTY/u)
})

test('Private Cloud release builds signed Linux x64 images and native bundles', async () => {
  const release = await workflow('private-cloud-release.yml')
  for (const dockerfile of ['Dockerfile.runtime-service', 'Dockerfile.runtime-ingress-gateway', 'Dockerfile.dashboard']) assert.match(release, new RegExp(dockerfile.replace('.', '\\.'), 'u'))
  assert.match(release, /^\s+platforms: linux\/amd64$/mu)
  assert.match(release, /provenance: mode=max/u)
  assert.match(release, /sbom: true/u)
  assert.match(release, /cosign sign --yes/u)
  assert.match(release, /cosign sign-blob --yes/u)
  assert.match(release, /actions\/attest-build-provenance@v3/u)
  assert.match(release, /^\s+target: \[linux-x64\]$/mu)
  assert.match(release, /build-private-cloud-bundle\.mjs/u)
  assert.match(release, /verify-private-cloud-bundle\.mjs/u)
  assert.match(release, /trivy image --scanners vuln/u)
  assert.match(release, /check-vulnerabilities\.mjs/u)
  assert.match(release, /image-vulnerability-scan/u)
  assert.doesNotMatch(release, /--draft=false/u)
})

test('Private Cloud promotion requires exact fresh-candidate evidence and cannot substitute optional predecessor evidence', async () => {
  const release = await workflowDocument('private-cloud-release.yml')
  const jobs = release.jobs
  const bundleRun = namedStep(jobs.bundle, 'Build immutable Compose bundle with native Operator').run
  assert.match(bundleRun, /verify-private-cloud-bundle\.mjs --release release\/private-cloud/u)
  const uploadRun = namedStep(jobs.bundle, 'Upload and verify owned Private Cloud release assets').run
  const draftGuard = uploadRun.indexOf('gh release view "$TAG" --json isDraft --jq .isDraft')
  const clobber = uploadRun.indexOf('gh release upload "$TAG" "$archive" "$signature" --clobber')
  assert.ok(draftGuard >= 0 && clobber > draftGuard, 'draft release guard must precede clobber upload')

  assert.deepEqual(jobs.fresh_beta_candidate_assets.needs, ['resolve', 'bundle'])
  assert.equal(jobs.fresh_beta_candidate_assets.if, "startsWith(github.ref, 'refs/tags/')")
  const stageRun = namedStep(jobs.fresh_beta_candidate_assets, 'Stage signed draft bundle and exact beta Executor').run
  assert.match(stageRun, /kala-private-cloud-\$\{VERSION\}-linux-x64\.tar\.gz/u)
  assert.match(stageRun, /private-cloud-linux-x64\.sigstore\.json/u)
  const stagedArtifact = jobs.fresh_beta_candidate_assets.steps.find((step) => step.uses === 'actions/upload-artifact@v5')
  assert.equal(stagedArtifact.with.name, 'private-cloud-beta-draft-assets-${{ github.run_id }}-${{ github.run_attempt }}')

  assert.deepEqual(jobs.fresh_beta_candidate_acceptance.needs, ['resolve', 'bundle', 'fresh_beta_candidate_assets'])
  assert.equal(jobs.fresh_beta_candidate_acceptance.if, "startsWith(github.ref, 'refs/tags/')")
  const stagedDownload = jobs.fresh_beta_candidate_acceptance.steps.find((step) => step.uses === 'actions/download-artifact@v5')
  assert.equal(stagedDownload.with.name, stagedArtifact.with.name)
  const freshRun = namedStep(jobs.fresh_beta_candidate_acceptance, 'Install the fresh beta candidate before browser, tenant, Executor and restore checks').run
  assert.match(freshRun, /--fresh-candidate --ephemeral-bundled-acceptance --candidate-archive "\$archive"/u)
  assert.match(freshRun, /verify-private-cloud-fresh-evidence\.mjs[\s\S]*--archive "\$archive" --tag "\$TAG" --revision "\$GITHUB_SHA"/u)
  assert.doesNotMatch(freshRun, /predecessor/iu)
  const freshUpload = jobs.fresh_beta_candidate_acceptance.steps.find((step) => step.uses === 'actions/upload-artifact@v5')
  assert.equal(freshUpload.if, 'always()')
  assert.equal(freshUpload.with.name, 'private-cloud-fresh-beta-evidence-${{ github.run_id }}-${{ github.run_attempt }}')

  const predecessor = jobs['clean-compose-acceptance']
  assert.ok(predecessor.needs.includes('fresh_beta_candidate_acceptance'))
  assert.match(predecessor.if, /needs\.fresh_beta_candidate_acceptance\.result == 'success'/u)
  const predecessorGuard = namedStep(predecessor, 'Verify GitHub-hosted VM, predecessor and test identities').run
  assert.match(predecessorGuard, /UNSUPPORTED_PREDECESSOR_OVERRIDE.*PREDECESSOR_TAG/u)
  const predecessorRun = namedStep(predecessor, 'Run complete clean Compose acceptance against signed candidate').run
  assert.match(predecessorRun, /--non-certifying-predecessor/u)
  assert.match(predecessorRun, /e\.category!=="private-cloud-predecessor"/u)
  assert.match(predecessorRun, /e\.certifying!==false/u)
  assert.match(predecessorRun, /unsupported-explicit-override/u)
  assert.doesNotMatch(predecessorRun, /fs\.writeFileSync|e\.certifying=false/u)
  const predecessorUpload = predecessor.steps.find((step) => step.uses === 'actions/upload-artifact@v5')
  assert.match(predecessorUpload.with.name, /^private-cloud-noncertifying-predecessor-evidence-/u)

  const promotion = await workflowDocument('promote-rc.yml')
  const promotionRuns = promotion.jobs.promote.steps.filter((step) => typeof step.run === 'string').map((step) => step.run).join('\n')
  assert.match(promotionRuns, /Fresh beta candidate install and restore \(exact signed draft release\).*\.conclusion/u)
  assert.match(promotionRuns, /private-cloud-fresh-beta-evidence-\$FRESH_RUN_ID-\$FRESH_RUN_ATTEMPT/u)
  assert.match(promotionRuns, /verify-private-cloud-fresh-evidence\.mjs[\s\S]*--archive "\$archive" --tag "\$TAG" --revision "\$REVISION"/u)
  assert.doesNotMatch(promotionRuns, /noncertifying-predecessor-evidence|clean-compose-acceptance/u)
})

test('release requires three POSIX and one Windows hosted Portable acceptances plus signed GHCR/asset workflows', async () => {
  const acceptance = await workflow('rc-acceptance.yml')
  for (const target of ['linux-x64', 'darwin-x64', 'darwin-arm64']) assert.match(acceptance, new RegExp('^\\s+- \\{[^\\n]*target: ' + target, 'mu'))
  assert.doesNotMatch(acceptance, /^\s+- \{[^\n]*target: linux-arm64/mu)
  assert.match(acceptance, /windows-portable-conpty:[\s\S]*runs-on: windows-latest/u)
  assert.match(acceptance, /verifyWindowsNodePtyCompanion[\s\S]*Move-Item acceptance\/candidate\/win32-x64 acceptance\/candidate\/prebuilds\/win32-x64/u)
  assert.match(acceptance, /verify-portable-native\.mjs/u)
  assert.doesNotMatch(acceptance, /runs-on: \[self-hosted/u)
  assert.doesNotMatch(acceptance, /--predecessor-asset/u)
  assert.match(acceptance, /portable:[\s\S]*?permissions:\s*\n\s+contents: write\s*\n\s+attestations: read/u)
  assert.doesNotMatch(acceptance, /gh release (?:edit|create|upload|delete)/u)
  assert.match(acceptance, /verify-checksum-index\.mjs/u)
  assert.doesNotMatch(acceptance, /sha256sum/u)
  assert.match(acceptance, /gh attestation verify/u)
  assert.match(acceptance, /same-version reinstall/u)

  const promotion = await workflow('promote-rc.yml')
  assert.match(promotion, /Release Clean-environment Acceptance/u)
  assert.match(promotion, /\.github\/workflows\/rc-acceptance\.yml/u)
  assert.match(promotion, /verify-rc-evidence\.mjs/u)
  assert.match(promotion, /\.head_sha/u)
  assert.match(promotion, /for workflow in release\.yml private-cloud-release\.yml/u)
  assert.match(promotion, /-f branch="\$TAG" -f event=push -f status=success/u)
  assert.match(promotion, /--jq '\.workflow_runs\[\]\.head_sha' \| awk/u)
  assert.doesNotMatch(promotion, /select\(\.head_sha/u)
  assert.doesNotMatch(promotion, /Windows release asset is not allowed/u)
  assert.match(promotion, /kala-executor-win32-x64\.exe[\s\S]*node-pty-win32-x64\.tar\.gz kala-executor-service-host-win32-x64\.exe install-executor\.ps1/u)
  assert.match(promotion, /gh release download "\$TAG" --dir "\$CANDIDATE"/u)
  assert.match(promotion, /verify-promotion-candidate\.mjs/u)
  assert.match(promotion, /kala-dashboard-with-runtime\.cjs/u)
  assert.doesNotMatch(promotion, /^\s+kala-host-(?:linux|darwin)-/mu)
  assert.match(promotion, /gh attestation verify/u)
  assert.match(promotion, /cosign verify-blob/u)
  assert.match(promotion, /SHA256SUMS\.sigstore\.json/u)
  assert.match(promotion, /gh release edit "\$TAG" --draft=false/u)
  assert.ok(promotion.indexOf('verify-rc-evidence.mjs') < promotion.indexOf('verify-promotion-candidate.mjs'))
  assert.ok(promotion.indexOf('verify-promotion-candidate.mjs') < promotion.indexOf('--draft=false'))
})

test('test discovery and release gates cannot silently omit task packs', async () => {
  const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  assert.match(rootPackage.scripts['test:extended'], /test:task-packs/u)
  const scripts = await readFile(resolve(root, 'scripts/testing/run-script-tests.mjs'), 'utf8')
  const taskPacks = await readFile(resolve(root, 'scripts/testing/run-task-pack-tests.mjs'), 'utf8')
  assert.match(scripts, /files\.length === 0/u)
  assert.match(taskPacks, /discovered === 0/u)
  assert.match(taskPacks, /No task-pack tests discovered/u)
})

test('evidence policy binds current records to clean revisions and explicit supersession', async () => {
  const policy = await readFile(resolve(root, 'docs/evidence/README.md'), 'utf8')
  for (const field of ['status', 'sourceRevision', 'generatedAt', 'supersedes', 'generator']) assert.match(policy, new RegExp('`' + field + '`', 'u'))
  const recorder = await readFile(resolve(root, 'scripts/evaluation/record-evidence-revision.mjs'), 'utf8')
  assert.match(recorder, /git', \['status', '--porcelain', '--untracked-files=all'\]/u)
  assert.match(recorder, /refusing to record current evidence from a dirty tree/u)
  assert.match(recorder, /flag: 'wx'/u)
})
