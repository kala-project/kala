import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const script = 'scripts/release/verify-private-cloud-clean-compose.mjs'
const identities = {
  PRIVATE_CLOUD_TEST_ALICE_EMAIL: 'alice@example.test',
  PRIVATE_CLOUD_TEST_ALICE_OIDC_ISSUER: 'https://identity.example.test',
  PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT: 'alice-idp-subject-7f2',
  PRIVATE_CLOUD_TEST_BOB_EMAIL: 'bob@example.test',
  PRIVATE_CLOUD_TEST_BOB_OIDC_ISSUER: 'https://identity.example.test',
  PRIVATE_CLOUD_TEST_BOB_OIDC_SUBJECT: 'bob-idp-subject-9a4',
}

const valid = {
  unitResourceIsolation: { aliceArtifactStatuses: [400], bobArtifactStatuses: [201] },
  restartRecovery: {
    queuePersistedBeforeRestart: true,
    queueHydratedAfterRestart: true,
    queuedMarkerRecovered: true,
    cursorBefore: 2,
    cursorRecovered: 2,
    cursorAfterMarker: 5,
    dagRunIdBefore: 'run-1',
    dagRunIdAfter: 'run-1',
    dagLeaseEventsBefore: 1,
    dagLeaseEventsAfter: 2,
  },
}

test('plans two distinct Organizations from explicit OIDC claims without exposing subjects', () => {
  const result = inspectProvisioning(identities)
  assert.equal(result.status, 0, result.stderr)
  const requests = JSON.parse(result.stdout).requests
  assert.deepEqual(requests.map(({ name, issuer, email }) => ({ name, issuer, email })), [
    { name: 'alice', issuer: identities.PRIVATE_CLOUD_TEST_ALICE_OIDC_ISSUER, email: identities.PRIVATE_CLOUD_TEST_ALICE_EMAIL },
    { name: 'bob', issuer: identities.PRIVATE_CLOUD_TEST_BOB_OIDC_ISSUER, email: identities.PRIVATE_CLOUD_TEST_BOB_EMAIL },
  ])
  assert.equal(requests[0].subject, undefined)
  assert.equal(requests[0].subjectSha256, createHash('sha256').update(identities.PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT).digest('hex'))
  assert.notEqual(requests[0].organizationName, requests[1].organizationName)
  assert.notEqual(requests[0].contractReference, requests[1].contractReference)
  assert.notEqual(requests[0].operationId, requests[1].operationId)
})

test('requires independent exact OIDC subjects and never falls back to owner email', () => {
  const missing = inspectProvisioning({ ...identities, PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT: '' })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT is required/u)

  const duplicate = inspectProvisioning({
    ...identities,
    PRIVATE_CLOUD_TEST_BOB_EMAIL: 'other@example.test',
    PRIVATE_CLOUD_TEST_BOB_OIDC_SUBJECT: identities.PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT,
  })
  assert.notEqual(duplicate.status, 0)
  assert.match(duplicate.stderr, /distinct exact OIDC issuer\/sub identities/u)
})

test('restores signed bundle file modes even under a strict host umask', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  assert.match(source, /run\('tar', \['--same-permissions', '-xzf', archive, '-C', destination\]\)/u)
  const scratch = mkdtempSync(join(tmpdir(), 'kala-bundle-permissions-'))
  try {
    const bundle = join(scratch, 'bundle')
    const output = join(scratch, 'output')
    mkdirSync(bundle)
    mkdirSync(output)
    const caddyfile = join(bundle, 'identity-local.Caddyfile')
    writeFileSync(caddyfile, 'respond /debug/healthz 200\n')
    chmodSync(caddyfile, 0o644)
    const archive = join(scratch, 'bundle.tar.gz')
    const packed = spawnSync('tar', ['-czf', archive, '-C', bundle, '.'], { encoding: 'utf8' })
    assert.equal(packed.status, 0, packed.stderr)
    const extracted = spawnSync('sh', ['-c', 'umask 077; tar --same-permissions -xzf "$1" -C "$2"', 'sh', archive, output], { encoding: 'utf8' })
    assert.equal(extracted.status, 0, extracted.stderr)
    assert.equal(statSync(join(output, 'identity-local.Caddyfile')).mode & 0o777, 0o644)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('installs either the candidate or predecessor before provisioning and first login', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  const selection = source.indexOf('const initialBundle = freshCandidate ? candidate : predecessor')
  const install = source.indexOf("operator(initialOperator, ['install'")
  const provision = source.indexOf('provisionAcceptanceOrganizations(worktreeOperator, env, organizationRequests)')
  const login = source.indexOf('const browser = await puppeteer.launch')
  assert.ok(selection >= 0 && install > selection && provision > install && login > provision)
  assert.match(source, /const initialOperator = freshCandidate \? candidateOperator : bundleOperator\(predecessor\)/u)
  assert.match(source, /worktreeOperator = join\(root, 'scripts\/deploy\/kala-private-cloud\.mjs'\)/u)
})

test('predecessor lifecycle binds signed archive identity and emits formal non-certifying evidence', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  assert.match(source, /predecessorTag = freshCandidate \? undefined : required\('--predecessor-tag'\)/u)
  assert.match(source, /predecessorManifest\.revision !== predecessorRevision/u)
  assert.match(source, /predecessorManifest\.version !== predecessorTag\.slice\(1\)/u)
  assert.match(source, /nonCertifyingPredecessor = process\.argv\.includes\('--non-certifying-predecessor'\)/u)
  assert.match(source, /category = freshCandidate \? 'private-cloud' : 'private-cloud-predecessor'/u)
  assert.match(source, /certifying: false, predecessorPolicy: 'unsupported-explicit-override'/u)
  assert.match(source, /verify-private-cloud-bundle\.mjs', '--release', path/u)
})

test('fresh mode requires no predecessor and proves candidate checks without upgrade or rollback claims', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  assert.match(source, /predecessorArchive = freshCandidate \? undefined/u)
  assert.match(source, /target = freshCandidate \? 'linux-x64-compose-fresh'/u)
  assert.match(source, /freshCandidateInstall: true/u)
  assert.match(source, /imageDigestPinning: true/u)
  const freshBranch = source.slice(source.indexOf('if (freshCandidate) {', source.indexOf("if (!workspace.stdout.trim())")), source.indexOf('} else {', source.indexOf("if (!workspace.stdout.trim())")))
  assert.match(freshBranch, /verifyCandidateRuntimeGates/u)
  assert.match(freshBranch, /verifyBackupRestore/u)
  assert.doesNotMatch(freshBranch, /upgrade|rollback/u)
})

test('ephemeral bundled mode creates real users before PAT removal, reuses identity volumes, and runs an authenticated digest-pinned model fixture', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  assert.match(source, /--ephemeral-bundled-acceptance/u)
  assert.match(source, /init-config[\s\S]*--identity', 'bundled'[\s\S]*--storage', 'local-volume'/u)
  const prepare = source.slice(source.indexOf('async function prepareEphemeralBundledAcceptance'), source.indexOf('function acceptanceOrganizationRequests'))
  const identityStart = prepare.indexOf("['up', '-d', 'identity-proxy']")
  const identityReady = prepare.indexOf("await waitForHttp(`${envFile(join(config, 'deployment.env')).OIDC_ISSUER}/debug/healthz`, 90_000)")
  const userEnrollment = prepare.indexOf("'--acceptance-users-file', usersFile")
  const identityStop = prepare.indexOf("['stop', 'identity-proxy'")
  assert.ok(identityStart >= 0 && identityReady > identityStart && userEnrollment > identityReady && identityStop > userEnrollment)
  assert.doesNotMatch(prepare, /down.*--volumes|KALA_FIXTURE_BEARER_TOKEN=\$\{bearer\}/u)
  const install = source.indexOf("operator(initialOperator, ['install'")
  const healthy = source.indexOf("await waitForHttp('http://localhost:13001/healthz', 90_000)")
  const fixtureCall = source.indexOf('await startAuthenticatedModelFixture({ candidate, candidateLock')
  assert.ok(install > 0 && healthy > install && fixtureCall > healthy)
  const fixture = source.slice(source.indexOf('async function startAuthenticatedModelFixture'), source.indexOf('function acceptanceOrganizationRequests'))
  assert.match(fixture, /network', 'inspect'[\s\S]*Installed Compose egress network is not owned by this project/u)
  assert.match(fixture, /candidateLock\.images\.runtime, '\/fixture\/server\.mjs'/u)
  assert.match(fixture, /--network-alias', 'fixture\.example\.com'[\s\S]*--cap-drop', 'ALL'[\s\S]*KALA_FIXTURE_BEARER_TOKEN_FILE=\/run\/fixture\/token/u)
  assert.match(prepare, /byName\.alice\.subject === byName\.bob\.subject/u)
  assert.match(source, /if \(modelFixture\) run\('docker', \['rm', '-f', modelFixture\], true\)/u)
})

test('keeps tenant capabilities protected until a browser has authenticated', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  assert.match(source, /fetch\('http:\/\/localhost:13001\/runtime\/capabilities'\)\)\.status !== 401/u)
  assert.match(source, /const capabilities = await page\.evaluate\(async \(\) => \{/u)
  assert.match(source, /await fetch\('\/runtime\/capabilities'\)/u)
  assert.doesNotMatch(source, /waitForHttp\([^\n]*\/runtime\/capabilities/u)
})

test('successful attachment creation uses HTTP 201, not 200', () => {
  const routes = readFileSync(resolve(root, 'packages/host/src/http/routes.ts'), 'utf8')
  const upload = routes.slice(routes.indexOf("path === '/runtime/attachments'"), routes.indexOf("path === '/runtime/attachments/release'"))
  assert.match(upload, /sendJsonStatus\(req, res, 201, \{ file \}\)/u)
})

test('accepts candidate Runtime gate evidence only when quota isolation and restart state are complete', () => {
  const result = check(valid)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { ok: true })
})

test('rejects a quota result that could hide cross-Unit coupling or partial admission', () => {
  const result = check({ ...valid, unitResourceIsolation: { aliceArtifactStatuses: [400], bobArtifactStatuses: [400] } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /per-Unit artifact quota/u)
})

test('rejects cursor regression or a missing recovered queued operation', () => {
  const result = check({ ...valid, restartRecovery: { ...valid.restartRecovery, queuedMarkerRecovered: false, cursorRecovered: 1 } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /queue or Session cursor/u)
})

test('rejects a queue snapshot that did not hydrate before dispatch', () => {
  const result = check({ ...valid, restartRecovery: { ...valid.restartRecovery, queueHydratedAfterRestart: false } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /queue or Session cursor/u)
})

test('rejects a replaced DAG run or lost lease history after restart', () => {
  const result = check({ ...valid, restartRecovery: { ...valid.restartRecovery, dagRunIdAfter: 'run-2', dagLeaseEventsAfter: 0 } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /DAG lease history/u)
})

function inspectProvisioning(env) {
  return spawnSync(process.execPath, [script, '--internal-inspect-organization-provisioning'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

function check(report) {
  return spawnSync(process.execPath, [script, '--internal-assert-runtime-gates'], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(report),
  })
}
