import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer as createHttpsServer } from 'node:https'
import test from 'node:test'
import { verifyExternalRestore } from './private-cloud-external-restore.mjs'
import { createAuthority, verifyHttps } from './private-cloud-hosted-tls.mjs'

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
  assert.match(freshBranch, /verifyExternalRestore/u)
  assert.doesNotMatch(freshBranch, /operator\([^)]*, \['(?:backup|restore)'/u)
  assert.doesNotMatch(freshBranch, /upgrade|rollback/u)
})

test('fresh external restore uses the provisioned PostgreSQL image, not the absent legacy Compose file', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  const provisioner = readFileSync(join(root, 'scripts/release/provision-private-cloud-hosted-authorities.mjs'), 'utf8')
  assert.match(provisioner, /'external-postgres': \{\s*image: postgres/u)
  assert.match(provisioner, /PRIVATE_CLOUD_EXTERNAL_POSTGRES_IMAGE: postgres/u)
  assert.match(source, /postgresImage: requiredEnv\('PRIVATE_CLOUD_EXTERNAL_POSTGRES_IMAGE'\)/u)
  assert.match(readFileSync(join(root, 'scripts/release/private-cloud-external-restore.mjs'), 'utf8'),
    /if \(!\/\^postgres@sha256:\[0-9a-f\]\{64\}\$\/u\.test\(postgresImage\)\)/u)
})

test('fresh acceptance fails before creating a configuration or certifying unsupported legacy storage', () => {
  for (const flags of [['--fresh-candidate'], ['--fresh-candidate', '--ephemeral-bundled-acceptance']]) {
    const result = spawnSync(process.execPath, [script, ...flags], { cwd: root, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /external OIDC|external OIDC enrollment/u)
    assert.match(result.stderr, /PostgreSQL\/S3/u)
    assert.doesNotMatch(result.stdout, /"ok":true/u)
  }
})

test('fresh acceptance restores private configuration directory modes after copying the hosted template', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  const copy = source.indexOf('cpSync(configTemplate, config, { recursive: true })')
  const configMode = source.indexOf('chmodSync(config, 0o700)', copy)
  const secretsMode = source.indexOf("chmodSync(join(config, 'secrets'), 0o700)", copy)
  const install = source.indexOf("operator(initialOperator, ['install'")
  assert.ok(copy >= 0 && configMode > copy && secretsMode > configMode && install > secretsMode)
})

test('fresh tenant and quota acceptance create Sessions only on matching routed sockets', () => {
  const tenant = readFileSync(join(root, 'scripts/private-cloud-local/acceptance/verify-tenant-isolation.mjs'), 'utf8')
  assert.match(tenant, /auth: \{ role: 'dashboard', sessionId, clientVersion: '1' \}/u)
  assert.match(tenant, /actors\.push\(\{ \.\.\.user, password, context, socket, sessionId,/u)
  assert.match(tenant, /const aliceSession = actors\[0\]\.sessionId/u)
  assert.match(tenant, /const bobSession = actors\[1\]\.sessionId/u)

  const source = readFileSync(resolve(root, script), 'utf8')
  assert.match(source, /aliceArtifactSocket = connectDashboard\(origin, alice\.cookie, aliceArtifactSession\)/u)
  assert.match(source, /socketAck\(aliceArtifactSocket, 'client:create_session', \{ operationId: operationId\(\), sessionId: aliceArtifactSession \}\)/u)
  assert.match(source, /socketAck\(alice\.socket, 'client:create_session', \{\s*operationId: operationId\(\), sessionId: chatSession/u)
})

test('hosted acceptance retains Docker registry authentication when isolating the browser home', () => {
  const provisioner = readFileSync(join(root, 'scripts/release/provision-private-cloud-hosted-authorities.mjs'), 'utf8')
  assert.match(provisioner, /const acceptanceEnv = \{ \.\.\.env, HOME: home,[\s\S]*?DOCKER_CONFIG: dockerConfigDirectory\(env\)/u)
  const command = ['scripts/release/provision-private-cloud-hosted-authorities.mjs', '--internal-docker-config-directory']
  const defaultConfig = spawnSync(process.execPath, command, { cwd: root, env: { HOME: '/tmp/runner' }, encoding: 'utf8' })
  assert.equal(defaultConfig.status, 0, defaultConfig.stderr)
  assert.equal(defaultConfig.stdout.trim(), '/tmp/runner/.docker')
  const customConfig = spawnSync(process.execPath, command, { cwd: root, env: { HOME: '/tmp/runner', DOCKER_CONFIG: '/tmp/private-docker' }, encoding: 'utf8' })
  assert.equal(customConfig.status, 0, customConfig.stderr)
  assert.equal(customConfig.stdout.trim(), '/tmp/private-docker')
  const missingConfig = spawnSync(process.execPath, command, { cwd: root, env: {}, encoding: 'utf8' })
  assert.notEqual(missingConfig.status, 0)
  assert.match(missingConfig.stderr, /HOME or DOCKER_CONFIG is required/u)
})

test('hosted authorities and the signed candidate share an isolated egress network instead of cross-bridge host ports', () => {
  const provisioner = readFileSync(join(root, 'scripts/release/provision-private-cloud-hosted-authorities.mjs'), 'utf8')
  const compose = readFileSync(join(root, 'deploy/private-cloud/compose.postgres-s3-base.yaml'), 'utf8')
  assert.match(provisioner, /run\('docker', \['network', 'create', sharedNetwork\], env\)/u)
  assert.match(provisioner, /run\('docker', \['network', 'create', '--subnet', sharedIpam\.Subnet, '--gateway', sharedGateway, sharedNetwork\], env\)/u)
  for (const [project, service, address] of [
    ['pgCompose', 'external-postgres', 'postgres'],
    ['identityCompose', 'identity-proxy', 'identity'],
    ['s3Compose', 'external-s3-tls', 's3'],
  ]) {
    assert.ok(provisioner.includes(`attachAuthority(${project}, '${service}', sharedIps.${address})`))
  }
  assert.match(provisioner, /KALA_RC_EGRESS_NETWORK=\$\{sharedNetwork\}\\nKALA_RC_EGRESS_EXTERNAL=true/u)
  assert.match(provisioner, /OIDC_DISCOVERY_ORIGIN=https:\/\/\$\{sharedIps\.identity\}:8443/u)
  assert.match(provisioner, /const endpoint = `https:\/\/\$\{sharedIps\.s3\}:8443`/u)
  assert.match(provisioner, /\$\{sharedIps\.postgres\}:5432/u)
  assert.match(compose, /name: \$\{KALA_RC_EGRESS_NETWORK:-\$\{COMPOSE_PROJECT_NAME:-kala-private-cloud-pg-s3-eval\}_egress\}/u)
  assert.match(compose, /external: \$\{KALA_RC_EGRESS_EXTERNAL:-false\}/u)
})

test('model fixture joins only the runner-owned external network shared with all three authorities', () => {
  const suffix = 'a1b2c3d4e5f6'
  const name = `runlab-rc-egress-${suffix}`
  const id = 'a'.repeat(64)
  const input = {
    rendered: { networks: { egress: { name, external: true } } },
    deployment: { KALA_RC_EGRESS_NETWORK: name, KALA_RC_EGRESS_EXTERNAL: 'true' },
    networkDetails: { Name: name, Id: id, Driver: 'bridge', Scope: 'local', Internal: false, Labels: {} },
    authorities: ['identity', 'postgres', 's3'].map((kind) => ({
      Config: { Labels: { 'com.docker.compose.project': `runlab-rc-${kind}-${suffix}` } },
      State: { Running: true },
      NetworkSettings: { Networks: { [name]: { NetworkID: id } } },
    })),
  }
  const inspect = (value) => spawnSync(process.execPath, [script, '--internal-assert-model-fixture-network'], {
    cwd: root, encoding: 'utf8', input: JSON.stringify(value),
  })
  assert.equal(inspect(input).status, 0)
  for (const change of [
    (value) => { value.rendered.networks.egress.name = 'other-egress' },
    (value) => { value.rendered.networks.egress.external = false },
    (value) => { value.networkDetails.Internal = true },
    (value) => { value.authorities[1].NetworkSettings.Networks[name].NetworkID = 'b'.repeat(64) },
    (value) => { value.authorities[2].Config.Labels['com.docker.compose.project'] = 'another-project' },
  ]) {
    const invalid = structuredClone(input)
    change(invalid)
    const result = inspect(invalid)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /egress network/u)
  }
})

test('fresh evidence requires runner-owned, independently labeled official authority containers', () => {
  const source = readFileSync(resolve(root, script), 'utf8')
  assert.match(source, /PRIVATE_CLOUD_EXTERNAL_AUTHORITY_CONTAINERS/u)
  assert.match(source, /container\?\.State\?\.Running !== true/u)
  assert.match(source, /new Set\(\[identityProject, postgresProject, s3Project, deployment\.COMPOSE_PROJECT_NAME\]\)\.size !== 4/u)
  assert.match(source, /buildx', 'imagetools', 'inspect', image/u)
  assert.match(source, /isolatedExternalOidc: true, externalPostgresS3: true, verifiedExternalRestore: true/u)
  const hosted = readFileSync(join(root, 'scripts/release/provision-private-cloud-hosted-authorities.mjs'), 'utf8')
  assert.match(hosted, /PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT: identities\[0\]\.subject/u)
  assert.match(hosted, /PRIVATE_CLOUD_TEST_BOB_OIDC_SUBJECT: identities\[1\]\.subject/u)
  assert.ok(source.indexOf('assertExternalConfig(config)') < source.indexOf("operator(initialOperator, ['install'"))
  assert.ok(source.indexOf('await verifyExternalRestore({') < source.indexOf('const evidence = createRcEvidence({'))
})

test('hosted OIDC provisioning removes the application service and exposes only its own pinned identity project', () => {
  const overlay = readFileSync(join(root, 'deploy/private-cloud/compose.identity-local.yaml'), 'utf8')
  const result = spawnSync(process.execPath, ['scripts/release/provision-private-cloud-hosted-authorities.mjs', '--internal-render-identity-overlay'], {
    cwd: root, encoding: 'utf8', input: overlay,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /identity-zitadel:/u)
  assert.match(result.stdout, /ghcr\.io\/zitadel\/zitadel@sha256:[0-9a-f]{64}/u)
  assert.match(result.stdout, /192\.0\.2\.1:13002:8443/u)
  assert.match(result.stdout, /127\.0\.0\.1:13003:8080/u)
  assert.match(result.stdout, /ZITADEL_EXTERNALSECURE: "true"/u)
  assert.match(result.stdout, /OIDC_DEFAULTLOGINURLV2: https:\/\/localhost:/u)
  assert.match(result.stdout, /identity-proxy:\n\s+user: "\d+:\d+"/u)
  assert.match(result.stdout, /\/run\/tls:ro/u)
  assert.doesNotMatch(result.stdout, /^\s{2}runtime-ingress:/mu)
  const provisioner = readFileSync(join(root, 'scripts/release/provision-private-cloud-hosted-authorities.mjs'), 'utf8')
  assert.match(provisioner, /renderIdentityOverlay\(overlay, bridge, proxyTlsDir\)/u)
  assert.match(provisioner, /cpSync\(authority\.leafKey, join\(directory, 'leaf-key\.pem'\)\)/u)
  assert.match(provisioner, /user: `\$\{process\.getuid\(\)\}:\$\{process\.getgid\(\)\}`/u)
  assert.match(provisioner, /\$\{s3ProxyTlsDir\}:\/run\/tls:ro/u)
  assert.match(readFileSync(join(root, '.github/workflows/private-cloud-release.yml'), 'utf8'), /node scripts\/release\/provision-private-cloud-hosted-authorities\.mjs \\\n\s+--bundle/u)
})

test('hosted OIDC proxy forwards the verified TLS origin without changing the bootstrap HTTP origin', () => {
  for (const filename of ['Caddyfile', 'single-origin.Caddyfile']) {
    const caddyfile = readFileSync(join(root, 'deploy/private-cloud/identity-local', filename), 'utf8')
    const result = spawnSync(process.execPath, ['scripts/release/provision-private-cloud-hosted-authorities.mjs', '--internal-render-identity-caddy'], {
      cwd: root, encoding: 'utf8', input: caddyfile,
    })
    assert.equal(result.status, 0, result.stderr)
    const [httpSite, tlsSite] = result.stdout.split('\n:8443 {')
    assert.match(httpSite, /header_up X-Forwarded-Proto (?:http|\{\$KALA_IDENTITY_SCHEME:http\})/u)
    assert.match(tlsSite, /tls \/run\/tls\/leaf\.pem \/run\/tls\/leaf-key\.pem/u)
    assert.match(tlsSite, /header_up X-Forwarded-Proto https/u)
  }
})

test('external authority provisioning refuses non-hosted Docker environments before creating resources', () => {
  const result = spawnSync(process.execPath, ['scripts/release/provision-private-cloud-hosted-authorities.mjs', '--bundle', '.'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' },
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /fresh GitHub-hosted runner/u)
})

test('hosted private CA verifies exact HTTPS peers and refuses a different CA', async () => {
  const scratch = mkdtempSync(join(root, '.runlab-rc-tls-test-'))
  const serverCertificate = createAuthority(join(scratch, 'server'), 's3-acceptance', '192.0.2.1', '198.51.100.1')
  const untrusted = createAuthority(join(scratch, 'untrusted'), 'other-acceptance')
  const server = createHttpsServer({
    key: readFileSync(serverCertificate.leafKey),
    cert: readFileSync(serverCertificate.leaf),
  }, (_request, response) => response.end('verified'))
  try {
    const leaf = new X509Certificate(readFileSync(serverCertificate.leaf))
    assert.equal(leaf.checkIP('192.0.2.1'), '192.0.2.1')
    assert.equal(leaf.checkIP('198.51.100.1'), '198.51.100.1')
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
    const url = `https://127.0.0.1:${server.address().port}/`
    assert.equal(await verifyHttps(url, serverCertificate.ca), 'verified')
    await assert.rejects(verifyHttps(url, untrusted.ca), /verify|certificate|self.signed/u)
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose))
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('external restore refuses unverified PostgreSQL images and HTTP object stores before mutation', async () => {
  const scratch = mkdtempSync(join(root, '.runlab-rc-external-restore-test-'))
  try {
    mkdirSync(join(scratch, 'secrets'))
    writeFileSync(join(scratch, 'deployment.env'), 'KALA_S3_ENDPOINT=http://localhost:9000\nKALA_S3_BUCKET=acceptance-only\nKALA_S3_REGION=us-east-1\n')
    writeFileSync(join(scratch, 'secrets', 'runtime_s3_access_key_id'), 'runtime-only')
    writeFileSync(join(scratch, 'secrets', 'installation_claim_s3_access_key_id'), 'claim-only')
    const calls = []
    const options = { config: scratch, backup: join(scratch, 'backup'), stop: () => calls.push('stop'), start: () => calls.push('start'), verifyRead: () => calls.push('read') }
    await assert.rejects(verifyExternalRestore({ ...options, postgresImage: 'postgres:latest' }), /verified official PostgreSQL image digest/u)
    await assert.rejects(verifyExternalRestore({ ...options, postgresImage: 'postgres@sha256:' + 'a'.repeat(64) }), /authenticated HTTPS authority/u)
    assert.deepEqual(calls, [])
  } finally { rmSync(scratch, { recursive: true, force: true }) }
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
