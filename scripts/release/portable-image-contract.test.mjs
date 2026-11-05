import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { inspectPortableAsset, revisionsMatch, versionFromTag } from './verify-portable-container.mjs'
import { verifyPortableAcceptanceEvidence } from './verify-portable-evidence.mjs'

const root = resolve(import.meta.dirname, '../..')

test('accepts a same-revision CJS with an embedded Dashboard', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'portable-image-contract-'))
  try {
    const asset = join(scratch, 'portable.cjs')
    writeFileSync(asset, '#!/usr/bin/env node\n' +
      'globalThis.__KALA_BUILD_INFO__={"releaseTag":"v0.3.0-beta.18","productVersion":"0.3.0-beta.18","gitCommit":"0123456789ab","artifactKind":"cjs","dashboardMode":"embedded"};\n' +
      'globalThis.__KALA_EMBEDDED_DASHBOARD__=[];\n')
    const result = inspectPortableAsset(asset, { tag: 'v0.3.0-beta.18', revision: '0123456789abcdef0123456789abcdef01234567' })
    assert.equal(result.build.dashboardMode, 'embedded')
    assert.match(result.sha256, /^[a-f0-9]{64}$/u)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('rejects stale version, revision, and non-embedded Dashboard metadata', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'portable-image-contract-'))
  try {
    const asset = join(scratch, 'portable.cjs')
    const writeAsset = (overrides = {}) => writeFileSync(asset, '#!/usr/bin/env node\n' +
      `globalThis.__KALA_BUILD_INFO__=${JSON.stringify({ releaseTag: 'v0.3.0-beta.18', productVersion: '0.3.0-beta.18', gitCommit: 'aaaaaaaaaaaa', artifactKind: 'cjs', dashboardMode: 'embedded', ...overrides })};\n` +
      'globalThis.__KALA_EMBEDDED_DASHBOARD__=[];\n')

    writeAsset({ dashboardMode: 'none' })
    assert.throws(() => inspectPortableAsset(asset, { tag: 'v0.3.0-beta.18', revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), /embed the Dashboard/u)
    writeAsset({ releaseTag: 'v0.2.0', productVersion: '0.2.0' })
    assert.throws(() => inspectPortableAsset(asset, { tag: 'v0.3.0-beta.18', revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), /release tag/u)
    writeAsset()
    assert.throws(() => inspectPortableAsset(asset, { tag: 'v0.3.0-beta.18', revision: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), /revision/u)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('requires semver tags and permits only unambiguous revision prefixes', () => {
  assert.equal(versionFromTag('v0.3.0-beta.18'), '0.3.0-beta.18')
  assert.throws(() => versionFromTag('latest'), /semantic version/u)
  assert.equal(revisionsMatch('0123456789ab', '0123456789abcdef'), true)
  assert.equal(revisionsMatch('0123456', '0123457'), false)
  assert.equal(revisionsMatch('0123', '0123456789abcdef'), false)
})

test('Dockerfile keeps the release context narrow and declares the runtime safety contract', () => {
  const dockerfile = readFileSync(join(root, 'deploy/portable/Dockerfile'), 'utf8')
  const ignore = readFileSync(join(root, 'deploy/portable/Dockerfile.dockerignore'), 'utf8')
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS verify/u)
  assert.match(dockerfile, /FROM gcr\.io\/distroless\/nodejs22-debian13@sha256:[0-9a-f]{64} AS node-runtime-source/u)
  assert.match(dockerfile, /FROM scratch AS node-runtime/u)
  assert.match(dockerfile, /COPY --from=verify --chown=65532:65532 \/opt\/kala\/kala-dashboard-with-runtime\.cjs/u)
  assert.match(dockerfile, /USER 65532:65532\nVOLUME \["\/var\/lib\/kala"\]/u)
  assert.doesNotMatch(dockerfile.slice(dockerfile.indexOf('FROM node-runtime AS runtime')), /\b(?:apt-get|npm|pnpm|RUN)\b/u)
  assert.match(dockerfile, /HOME=\/var\/lib\/kala/u)
  assert.match(dockerfile, /KALA_BIND_HOST=0\.0\.0\.0/u)
  assert.match(dockerfile, /sha256sum --check --strict/u)
  assert.match(dockerfile, /io\.kala\.portable\.runtime\.source=/u)
  assert.equal(ignore.split('\n')[0], '**')
  assert.match(ignore, /!release\/kala-dashboard-with-runtime\.cjs/u)
})

test('isolated Docker acceptance matches the Portable Host public-origin gate without weakening it', () => {
  const verifier = readFileSync(join(root, 'scripts/release/verify-portable-container.mjs'), 'utf8')
  assert.ok(verifier.includes("'--publish', '127.0.0.1:3000:3000'"))
  assert.ok(verifier.includes('/socket.io/?EIO=4&transport=polling'))
  assert.ok(!verifier.includes("'KALA_PUBLIC_URLS=http://*'"))
})

test('portable candidate workflow binds the manual dispatch to signed tag assets and full revision', () => {
  const workflow = readFileSync(join(root, '.github/workflows/portable-image-release.yml'), 'utf8')
  assert.match(workflow, /workflow_dispatch:/u)
  assert.match(workflow, /ACCEPTED_TAG: v0\.3\.0/u)
  assert.match(workflow, /test "\$TAG" = "\$ACCEPTED_TAG"/u)
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/tags\/\$TAG"/u)
  assert.match(workflow, /GITHUB_WORKFLOW_REF" = "\$GITHUB_REPOSITORY\/\.github\/workflows\/portable-image-release\.yml@refs\/tags\/\$TAG"/u)
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/u)
  assert.match(workflow, /refs\/tags\/\$TAG:refs\/tags\/\$TAG/u)
  const verify = workflow.slice(workflow.indexOf('  verify-candidate:'), workflow.indexOf('  build-sign-and-policy:'))
  assert.match(verify, /pnpm install --frozen-lockfile[\s\S]*node scripts\/release\/verify-portable-container\.mjs/u)
  assert.match(workflow, /gh release view "\$TAG" --json tagName,isDraft/u)
  assert.match(workflow, /release\.tagName !== process\.env\.TAG \|\| release\.isDraft !== true/u)
  assert.doesNotMatch(workflow, /releases\/tags\/\$TAG/u)
  assert.match(workflow, /SHA256SUMS\.sigstore\.json/u)
  assert.match(workflow, /release\.yml@refs\/tags\/\$TAG/u)
  assert.match(workflow, /verify-checksum-index\.mjs[\s\S]*--revision "\$REVISION"/u)
  assert.match(workflow, /--inspect-artifact/u)
  assert.doesNotMatch(workflow, /(?:--asset|sha256sum) ["']?release\/kala-dashboard-with-runtime\.cjs/u, 'workflow must not consume the stale worktree release directory')
})

test('portable candidate workflow pins amd64 base, signs and verifies digests, and emits SBOM policy evidence', () => {
  const workflow = readFileSync(join(root, '.github/workflows/portable-image-release.yml'), 'utf8')
  assert.match(workflow, /\^sha256:\[0-9a-f\]\{64\}\$/u)
  assert.match(workflow, /platforms: linux\/amd64/u)
  assert.match(workflow, /docker pull --platform linux\/amd64/u)
  assert.match(workflow, /cosign sign --yes "\$IMAGE"/u)
  assert.match(workflow, /cosign verify [\s\S]*"\$IMAGE"/u)
  assert.match(workflow, /cosign attest --yes --type spdxjson/u)
  assert.match(workflow, /gh attestation verify "oci:\/\/\$IMAGE"[\s\S]*--cert-identity "\$IDENTITY"[\s\S]*--predicate-type https:\/\/slsa\.dev\/provenance\/v1/u)
  assert.match(workflow, /cosign verify-attestation --type spdxjson/u)
  assert.match(workflow, /provenance: mode=max/u)
  assert.match(workflow, /sbom: true/u)
  assert.match(workflow, /check-vulnerabilities\.mjs/u)
  assert.doesNotMatch(workflow, /visibility.*public|gh api[^\n]*visibility/iu)
})

test('isolated VM acceptance is explicit, fail-closed when required, and never runs Box E2E', () => {
  const workflow = readFileSync(join(root, '.github/workflows/portable-image-release.yml'), 'utf8')
  assert.match(workflow, /if: inputs\.require_isolated_vm_acceptance == true[\s\S]*runs-on: ubuntu-24\.04/u)
  assert.match(workflow, /RUNNER_ENVIRONMENT: \$\{\{ runner\.environment \}\}[\s\S]*test "\$RUNNER_ENVIRONMENT" = github-hosted/u)
  assert.doesNotMatch(workflow, /KALA_PORTABLE_CONTAINER_ACCEPTANCE_RUNNER_ENABLED|runs-on: \[self-hosted/u)
  assert.match(workflow, /KALA_PORTABLE_CONTAINER_ACCEPTANCE_VM: '1'/u)
  assert.match(workflow, /--isolated-vm/u)
  assert.match(workflow, /ACCEPTANCE_REQUIRED/u)
  assert.match(workflow, /test "\$ACCEPTANCE_REQUIRED" = true/u)
  assert.match(workflow, /test "\$ACCEPTANCE_RESULT" = success/u)
  assert.match(workflow, /this workflow still does not make the package public/u)
  assert.doesNotMatch(workflow, /product-system-e2e|private-cloud-product-e2e|ci:product-e2e|runs-on:.*box/iu)
})

test('acceptance evidence allowlist rejects privacy-sensitive additions', () => {
  const evidence = {
    ok: true,
    category: 'portable-container',
    image: `ghcr.io/example/kala@sha256:${'a'.repeat(64)}`,
    imageId: `sha256:${'b'.repeat(64)}`,
    architecture: 'amd64',
    tag: 'v0.3.0-beta.18',
    version: '0.3.0-beta.18',
    revision: 'c'.repeat(40),
    checks: { nonRoot: true, persistentVolume: true, loopbackPublish: true, capabilities: true, dashboard: true, sessionPersistence: true },
  }
  assert.equal(verifyPortableAcceptanceEvidence(evidence, { image: evidence.image, tag: evidence.tag, revision: evidence.revision }), evidence)
  assert.throws(() => verifyPortableAcceptanceEvidence({ ...evidence, runnerHost: 'box' }, { image: evidence.image, tag: evidence.tag, revision: evidence.revision }), /privacy-sensitive/u)
})
