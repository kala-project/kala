#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer-core'
import { io } from 'socket.io-client'
import { loginWithPassword } from '../product-e2e/harness.mjs'
import { createRcEvidence } from './rc-evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
if (process.argv.includes('--internal-assert-runtime-gates')) {
  assertRuntimeGateReport(json(readFileSync(0, 'utf8')))
  process.stdout.write(JSON.stringify({ ok: true }) + '\n')
  process.exit(0)
}
if (process.argv.includes('--internal-inspect-organization-provisioning')) {
  process.stdout.write(JSON.stringify(inspectOrganizationProvisioning(acceptanceOrganizationRequests('runlab-rc-test'))) + '\n')
  process.exit(0)
}
const freshCandidate = process.argv.includes('--fresh-candidate')
const nonCertifyingPredecessor = process.argv.includes('--non-certifying-predecessor')
const ephemeralBundledAcceptance = process.argv.includes('--ephemeral-bundled-acceptance')
if (ephemeralBundledAcceptance && !freshCandidate) throw new Error('--ephemeral-bundled-acceptance requires --fresh-candidate')
if (nonCertifyingPredecessor === freshCandidate) throw new Error('exactly one of --fresh-candidate or --non-certifying-predecessor is required')
const candidateArchive = resolve(required('--candidate-archive'))
const predecessorArchive = freshCandidate ? undefined : resolve(required('--predecessor-archive'))
const executorAsset = resolve(required('--executor'))
const tag = required('--tag')
const revision = required('--revision')
const predecessorRevision = freshCandidate ? undefined : required('--predecessor-revision')
const predecessorTag = freshCandidate ? undefined : required('--predecessor-tag')
if (predecessorTag && (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(predecessorTag) || predecessorTag === tag)) throw new Error('Private Cloud predecessor tag must be valid and distinct')
const output = resolve(required('--output'))
const configTemplate = ephemeralBundledAcceptance ? undefined : resolve(requiredEnv('KALA_RC_PRIVATE_CLOUD_CONFIG_TEMPLATE'))
const scratch = mkdtempSync(join(tmpdir(), 'runlab-rc-private-cloud-'))
const operatorRoot = join(scratch, 'operator')
const config = join(scratch, 'config')
const backup = join(scratch, 'backup')
const workspaceRoot = join(scratch, 'workspace')
const candidate = extract(candidateArchive, join(scratch, 'candidate'))
const predecessor = predecessorArchive ? extract(predecessorArchive, join(scratch, 'predecessor')) : undefined
const project = 'runlab-rc-' + randomBytes(6).toString('hex')
const worktreeOperator = join(root, 'scripts/deploy/kala-private-cloud.mjs')
let installed = false
let executor
let alicePassword
const modelFixture = ephemeralBundledAcceptance ? `${project}-model-fixture` : undefined

try {
  verify(candidate)
  if (predecessor) verify(predecessor)
  const candidateManifest = json(readFileSync(join(candidate, 'manifest.json'), 'utf8'))
  if (candidateManifest.revision !== revision) throw new Error('Private Cloud candidate revision mismatch')
  if (candidateManifest.version !== tag.slice(1)) throw new Error('Private Cloud candidate version mismatch')
  const candidateLock = json(readFileSync(join(candidate, 'image-lock.json'), 'utf8'))
  assertDigestPinnedImages(candidateLock)
  const predecessorManifest = predecessor ? json(readFileSync(join(predecessor, 'manifest.json'), 'utf8')) : undefined
  if (predecessorManifest && predecessorManifest.revision !== predecessorRevision) throw new Error('Private Cloud predecessor revision mismatch')
  if (predecessorManifest && predecessorManifest.version !== predecessorTag.slice(1)) throw new Error('Private Cloud predecessor version mismatch')
  const predecessorLock = predecessor ? json(readFileSync(join(predecessor, 'image-lock.json'), 'utf8')) : undefined
  const hybrid = freshCandidate ? undefined : join(scratch, 'dashboard-candidate')
  if (hybrid) {
    run(process.execPath, [
      'scripts/release/build-private-cloud-bundle.mjs', '--output', hybrid,
      '--runtime-image', predecessorLock.images.runtime, '--ingress-image', predecessorLock.images.ingress,
      '--dashboard-image', candidateLock.images.dashboard, '--revision', revision,
      '--operator', bundleOperator(candidate),
    ])
    verify(hybrid)
  }

  const candidateOperator = bundleOperator(candidate)
  if (ephemeralBundledAcceptance) {
    operator(candidateOperator, ['init-config', '--bundle', candidate, '--config-dir', config, '--profile', 'local', '--identity', 'bundled', '--storage', 'local-volume'], { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: operatorRoot })
    rewriteDeploymentEnv(join(config, 'deployment.env'), project)
    const acceptance = await prepareEphemeralBundledAcceptance({ candidate, candidateLock, config, project, operatorRoot, modelFixture })
    Object.assign(process.env, acceptance.environment)
  } else {
    cpSync(configTemplate, config, { recursive: true })
    requirePrivateConfig(config)
    rewriteDeploymentEnv(join(config, 'deployment.env'), project)
  }
  const organizationRequests = acceptanceOrganizationRequests(project)
  alicePassword = requiredEnv('PRIVATE_CLOUD_TEST_ALICE_PASSWORD')
  const env = { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: operatorRoot }
  if (freshCandidate) configureRuntimeGateLimits(join(config, 'deployment.env'))
  const initialBundle = freshCandidate ? candidate : predecessor
  const initialOperator = freshCandidate ? candidateOperator : bundleOperator(predecessor)
  const installedResult = operator(initialOperator, ['install', '--bundle', initialBundle, '--config-dir', config], env)
  installed = true
  if (!installedResult.ok || installedResult.receipt?.phase !== 'completed') throw new Error(`Private Cloud ${freshCandidate ? 'fresh candidate' : 'predecessor'} install did not complete`)
  assertServicesReady(installedResult.services)
  await waitForHttp('http://localhost:13001/healthz', 90_000)
  if (ephemeralBundledAcceptance) await startAuthenticatedModelFixture({ candidate, candidateLock, config, project, modelFixture })
  if ((await fetch('http://localhost:13001/runtime/capabilities')).status !== 401) throw new Error('Private Cloud exposed tenant capabilities without authentication')
  provisionAcceptanceOrganizations(worktreeOperator, env, organizationRequests)

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    alicePassword = await loginWithPassword(page, { productOrigin: 'http://localhost:13001', loginName: requiredEnv('PRIVATE_CLOUD_TEST_ALICE_EMAIL'), password: alicePassword })
    const capabilities = await page.evaluate(async () => {
      const response = await fetch('/runtime/capabilities')
      if (!response.ok) throw new Error('authenticated tenant capabilities returned ' + response.status)
      return response.json()
    })
    if (capabilities.product !== 'private-cloud' || capabilities.deployment?.tenancy !== 'multi-tenant') throw new Error('Private Cloud authenticated tenant capabilities are incorrect')
    const invite = await page.evaluate(async () => {
      const response = await fetch('/auth/executor-invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'RC clean acceptance' }) })
      if (!response.ok) throw new Error('executor invite returned ' + response.status)
      return response.json()
    })
    if (!invite.inviteToken) throw new Error('Private Cloud did not issue an Executor invite')
    if (!existsSync(executorAsset)) throw new Error('Private Cloud acceptance Executor is missing')
    chmodSync(executorAsset, 0o755)
    const executorHome = join(scratch, 'executor-home')
    mkdirSync(executorHome, { recursive: true }); mkdirSync(workspaceRoot, { recursive: true })
    const logs = []
    executor = spawn(executorAsset, ['--host', 'http://localhost:13001', '--invite', invite.inviteToken, '--sandbox-root', workspaceRoot, '--name', 'rc-private-cloud-workspace'], { cwd: workspaceRoot, env: { ...process.env, HOME: executorHome }, stdio: ['ignore', 'pipe', 'pipe'] })
    executor.stdout.on('data', (chunk) => logs.push(String(chunk))); executor.stderr.on('data', (chunk) => logs.push(String(chunk)))
    await waitFor(() => logs.some((line) => line.includes('executor announced')), 30_000, 'Private Cloud Executor connection')
  } finally { await browser.close() }

  const effectiveCredentials = join(scratch, 'effective-credentials.json')
  run(process.execPath, ['scripts/private-cloud-local/acceptance/verify-tenant-isolation.mjs'], false, {
    ...env, PRIVATE_CLOUD_TEST_ALICE_PASSWORD: alicePassword, PRIVATE_CLOUD_EFFECTIVE_CREDENTIALS_FILE: effectiveCredentials,
  })
  const credentials = json(readFileSync(effectiveCredentials, 'utf8'))
  alicePassword = credentials.alice
  if (typeof alicePassword !== 'string' || !alicePassword || typeof credentials.bob !== 'string' || !credentials.bob) throw new Error('Private Cloud tenant acceptance did not preserve the effective credentials')
  const workspace = run(process.execPath, ['scripts/private-cloud-local/acceptance/verify-full-workspace.mjs'], false, {
    ...env,
    PRIVATE_CLOUD_TEST_EMAIL: requiredEnv('PRIVATE_CLOUD_TEST_ALICE_EMAIL'),
    PRIVATE_CLOUD_TEST_PASSWORD: alicePassword,
    PRIVATE_CLOUD_TEST_WORKSPACE_ROOT: workspaceRoot,
    PRIVATE_CLOUD_TEST_WORKSPACE_NAME: 'rc-private-cloud-workspace',
    PRIVATE_CLOUD_WORKSPACE_MARKER: 'RC-' + randomBytes(6).toString('hex').toUpperCase(),
  })
  if (!workspace.stdout.trim()) throw new Error('Private Cloud Browser/Executor flow produced no result')

  if (freshCandidate) {
    verifyMtlsClientRejection(candidate, config)
    const runtimeGates = await verifyCandidateRuntimeGates({ candidate, config, alicePassword, bobPassword: credentials.bob })
    assertRuntimeGateReport(runtimeGates)
    await verifyBackupRestore({ operatorBinary: candidateOperator, release: candidate, config, backup, env })
  } else {
    const beforeDashboard = operator(candidateOperator, ['status'], env).services
    const dashboardUpgrade = operator(candidateOperator, ['upgrade-dashboard', '--bundle', hybrid], env)
    if (dashboardUpgrade.receipt?.phase !== 'completed') throw new Error('Private Cloud Dashboard-only upgrade did not complete')
    if (beforeDashboard['runtime-host'].containerId !== dashboardUpgrade.services['runtime-host'].containerId || beforeDashboard['runtime-ingress'].containerId !== dashboardUpgrade.services['runtime-ingress'].containerId || beforeDashboard.dashboard.containerId === dashboardUpgrade.services.dashboard.containerId) throw new Error('Dashboard-only update did not preserve Runtime and Ingress identity')
    const dashboardRollback = operator(candidateOperator, ['rollback'], env)
    if (dashboardRollback.receipt?.phase !== 'completed' || dashboardRollback.active.images.runtime !== predecessorLock.images.runtime || dashboardRollback.active.images.ingress !== predecessorLock.images.ingress || dashboardRollback.active.images.dashboard !== predecessorLock.images.dashboard) throw new Error('Private Cloud Dashboard rollback did not restore the predecessor release')
    const dashboardUpgradeAgain = operator(candidateOperator, ['upgrade-dashboard', '--bundle', hybrid], env)
    if (dashboardUpgradeAgain.receipt?.phase !== 'completed') throw new Error('Private Cloud Dashboard-only upgrade could not be repeated after rollback')

    configureRuntimeGateLimits(join(config, 'deployment.env'))
    const fullUpgrade = operator(candidateOperator, ['upgrade', '--bundle', candidate], env)
    if (fullUpgrade.receipt?.phase !== 'completed') throw new Error('Private Cloud full upgrade did not complete')
    assertServicesReady(fullUpgrade.services)
    await waitForHttp('http://localhost:13001/healthz', 90_000)
    verifyMtlsClientRejection(candidate, config)
    const runtimeGates = await verifyCandidateRuntimeGates({ candidate, config, alicePassword, bobPassword: credentials.bob })
    assertRuntimeGateReport(runtimeGates)
    const fullRollback = operator(candidateOperator, ['rollback'], env)
    if (fullRollback.receipt?.phase !== 'completed' || fullRollback.active.images.runtime !== predecessorLock.images.runtime || fullRollback.active.images.ingress !== predecessorLock.images.ingress || fullRollback.active.images.dashboard !== candidateLock.images.dashboard) throw new Error('Private Cloud full rollback did not restore the persisted mixed predecessor')
    await verifyBackupRestore({ operatorBinary: candidateOperator, release: predecessor, config, backup, env })
  }

  const category = freshCandidate ? 'private-cloud' : 'private-cloud-predecessor'
  const target = freshCandidate ? 'linux-x64-compose-fresh' : 'linux-x64-compose'
  const evidence = createRcEvidence({
    category, target, tag, version: tag.slice(1), revision, ok: true,
    ...(freshCandidate ? {} : { certifying: false, predecessorPolicy: 'unsupported-explicit-override' }),
    artifact: { name: basename(candidateArchive), sha256: digest(readFileSync(candidateArchive)) },
    checks: freshCandidate
      ? { assetIntegrity: true, imageDigestPinning: true, freshCandidateInstall: true, ...(ephemeralBundledAcceptance ? { ephemeralBundledAcceptance: true, realBundledIdentities: true, authenticatedModelFixture: true } : {}), organizationProvisioning: true, tenantIsolation: true, browser: true, executor: true, mtlsClientRejection: true, unitResourceIsolation: true, runtimeRestartRecovery: true, backupRestore: true }
      : { assetIntegrity: true, cleanInstall: true, organizationProvisioning: true, tenantIsolation: true, browser: true, executor: true, fullUpgrade: true, mtlsClientRejection: true, unitResourceIsolation: true, runtimeRestartRecovery: true, dashboardUpgradeIsolation: true, rollback: true, backupRestore: true },
  })
  mkdirSync(resolve(output, '..'), { recursive: true, mode: 0o700 })
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ ok: true, category, target, evidence: basename(output) }) + '\n')
} finally {
  if (executor) { executor.kill('SIGTERM'); await new Promise((resolveExit) => { const timer = setTimeout(() => { executor.kill('SIGKILL'); resolveExit() }, 5_000); executor.once('exit', () => { clearTimeout(timer); resolveExit() }) }) }
  if (modelFixture) run('docker', ['rm', '-f', modelFixture], true)
  if (installed) {
    try {
      const active = json(readFileSync(join(operatorRoot, 'installation.json'), 'utf8'))
      operator(bundleOperator(candidate), ['uninstall', '--confirm', 'UNINSTALL:' + active.installationId], { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: operatorRoot })
    } catch {}
  }
  cleanupProject(project)
  rmSync(scratch, { recursive: true, force: true })
}

async function prepareEphemeralBundledAcceptance({ candidate, candidateLock, config, project, operatorRoot, modelFixture }) {
  const suffix = randomBytes(6).toString('hex')
  const users = ['alice', 'bob'].map((name) => ({
    name,
    email: `${name}-${suffix}@example.test`,
    password: `${name === 'alice' ? 'A' : 'B'}a1!${randomBytes(30).toString('base64url')}`,
  }))
  const usersFile = join(config, 'acceptance-users.json')
  writeFileSync(usersFile, JSON.stringify({ users }) + '\n', { mode: 0o600, flag: 'wx' })
  const bearer = randomBytes(36).toString('base64url')
  writeFileSync(join(config, 'secrets', 'llm_api_key'), bearer + '\n', { mode: 0o600 })
  writeFileSync(join(config, 'runtime-provider-catalog.json'), JSON.stringify({
    version: 1,
    defaultModel: 'acceptance-openai:kala-deterministic',
    providers: [{
      id: 'acceptance-openai', label: 'Authenticated deterministic acceptance fixture', wire: 'openai',
      baseUrl: 'http://fixture.example.com:3000/v1', credentialRef: 'file:llm_api_key',
      models: [{ id: 'kala-deterministic', label: 'Kala deterministic tool fixture', contextWindow: 32768 }],
    }],
  }, null, 2) + '\n', { mode: 0o600 })

  const invocation = composeInvocation(candidate, config, ['up', '-d', 'identity-proxy'])
  run(invocation.command, invocation.args, false, invocation.env, invocation.cwd)
  // Compose --wait includes identity-zitadel, which deliberately has no HEALTHCHECK.
  // Its dependent identity-zitadel-health checks the real Zitadel endpoint; also
  // require a successful request through the public identity proxy before enrollment.
  await waitForHttp(`${envFile(join(config, 'deployment.env')).OIDC_ISSUER}/debug/healthz`, 90_000)
  const configInvocation = composeInvocation(candidate, config, ['config', '--format', 'json'])
  const rendered = json(run(configInvocation.command, configInvocation.args, false, configInvocation.env, configInvocation.cwd).stdout)
  const bootstrapVolume = rendered.volumes?.['identity-zitadel-bootstrap']?.name ?? `${project}_identity-zitadel-bootstrap`
  const identityImage = rendered.services?.['identity-init']?.image
  if (!/^alpine(?::[^\s@]+)?@sha256:[0-9a-f]{64}$/u.test(identityImage ?? '')) throw new Error('Ephemeral bundled acceptance identity bootstrap image is not an immutable Alpine digest')
  const enrolled = json(run(process.execPath, [
    join(candidate, 'bootstrap-private-cloud-identity.mjs'), '--config-dir', config,
    '--bootstrap-volume', bootstrapVolume, '--identity-image', identityImage,
    '--acceptance-users-file', usersFile,
  ], false, invocation.env, candidate).stdout)
  const byName = Object.fromEntries((enrolled.acceptanceUsers ?? []).map((user) => [user.name, user]))
  if (!byName.alice?.subject || !byName.bob?.subject || byName.alice.subject === byName.bob.subject || byName.alice.email !== users[0].email || byName.bob.email !== users[1].email) throw new Error('Bundled identity did not return two distinct exact acceptance user identities')
  const stop = composeInvocation(candidate, config, ['stop', 'identity-proxy', 'identity-login', 'identity-zitadel-health', 'identity-zitadel', 'identity-postgres'])
  run(stop.command, stop.args, false, stop.env, stop.cwd)

  const issuer = envFile(join(config, 'deployment.env')).OIDC_ISSUER
  return { environment: {
    PRIVATE_CLOUD_TEST_ALICE_EMAIL: byName.alice.email,
    PRIVATE_CLOUD_TEST_ALICE_PASSWORD: users[0].password,
    PRIVATE_CLOUD_TEST_ALICE_OIDC_ISSUER: issuer,
    PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT: byName.alice.subject,
    PRIVATE_CLOUD_TEST_BOB_EMAIL: byName.bob.email,
    PRIVATE_CLOUD_TEST_BOB_PASSWORD: users[1].password,
    PRIVATE_CLOUD_TEST_BOB_OIDC_ISSUER: issuer,
    PRIVATE_CLOUD_TEST_BOB_OIDC_SUBJECT: byName.bob.subject,
    KALA_PRIVATE_CLOUD_OPERATOR_ROOT: operatorRoot,
  } }
}

async function startAuthenticatedModelFixture({ candidate, candidateLock, config, project, modelFixture }) {
  const configInvocation = composeInvocation(candidate, config, ['config', '--format', 'json'])
  const rendered = json(run(configInvocation.command, configInvocation.args, false, configInvocation.env, configInvocation.cwd).stdout)
  const network = rendered.networks?.egress?.name ?? `${project}_egress`
  const labels = run('docker', ['network', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}/{{index .Labels "com.docker.compose.network"}}', network]).stdout.trim()
  if (labels !== `${project}/egress`) throw new Error('Installed Compose egress network is not owned by this project')
  run('docker', [
    'run', '-d', '--name', modelFixture, '--network', network, '--network-alias', 'fixture.example.com',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '64', '--memory', '128m', '--cpus', '0.25', '--user', `${process.getuid()}:${process.getgid()}`,
    '-e', 'KALA_FIXTURE_BEARER_TOKEN_FILE=/run/fixture/token',
    '-v', `${join(config, 'secrets', 'llm_api_key')}:/run/fixture/token:ro`,
    '-v', `${join(root, 'scripts/release/private-cloud-openai-fixture.mjs')}:/fixture/server.mjs:ro`,
    candidateLock.images.runtime, '/fixture/server.mjs',
  ])
  await waitFor(() => {
    const running = run('docker', ['inspect', '--format', '{{.State.Running}}', modelFixture], true).stdout.trim() === 'true'
    const ready = run('docker', ['logs', modelFixture], true).stdout.includes('"ready":true')
    return running && ready
  }, 20_000, 'authenticated OpenAI-compatible acceptance fixture')
}

function acceptanceOrganizationRequests(project) {
  const endsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const requests = ['alice', 'bob'].map((name) => ({
    name,
    issuer: requiredEnv(`PRIVATE_CLOUD_TEST_${name.toUpperCase()}_OIDC_ISSUER`),
    subject: requiredEnv(`PRIVATE_CLOUD_TEST_${name.toUpperCase()}_OIDC_SUBJECT`),
    email: requiredEnv(`PRIVATE_CLOUD_TEST_${name.toUpperCase()}_EMAIL`),
    organizationName: `RC clean acceptance ${name} ${project}`,
    contractReference: `${project}-${name}`,
    endsAt,
    operationId: `${project}-provision-${name}`,
  }))
  if (requests[0].issuer === requests[1].issuer && requests[0].subject === requests[1].subject) throw new Error('Private Cloud acceptance owners must use distinct exact OIDC issuer/sub identities')
  return requests
}

function provisionAcceptanceOrganizations(binary, env, requests) {
  const organizationIds = requests.map((request) => {
    const result = operator(binary, [
      'provision-organization', '--owner-issuer', request.issuer, '--owner-subject', request.subject,
      '--owner-email', request.email, '--organization-name', request.organizationName,
      '--contract-reference', request.contractReference, '--ends-at', request.endsAt,
      '--operation-id', request.operationId,
    ], env)
    if (typeof result.organizationId !== 'string' || !result.organizationId) throw new Error(`Private Cloud ${request.name} organization provisioning returned no organization ID`)
    return result.organizationId
  })
  if (new Set(organizationIds).size !== requests.length) throw new Error('Private Cloud acceptance owners were provisioned into the same Organization')
}

function inspectOrganizationProvisioning(requests) {
  return { requests: requests.map((request) => ({ ...request, subject: undefined, subjectSha256: digest(request.subject) })) }
}

function configureRuntimeGateLimits(path) {
  const names = new Set(['KALA_RUNTIME_UNIT_MAX_QUEUED_MESSAGES', 'KALA_RUNTIME_UNIT_MAX_ARTIFACT_BYTES'])
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line && !names.has(line.split('=', 1)[0]))
  // The recovery journey deliberately queues a shell turn and its follow-up
  // before restarting Runtime. One slot rejects the second message before the
  // durability invariant can be exercised; keep the acceptance ceiling at two.
  lines.push('KALA_RUNTIME_UNIT_MAX_QUEUED_MESSAGES=2', 'KALA_RUNTIME_UNIT_MAX_ARTIFACT_BYTES=1048576')
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 })
}

function assertDigestPinnedImages(lock) {
  for (const name of ['runtime', 'ingress', 'dashboard']) {
    if (typeof lock?.images?.[name] !== 'string' || !/@sha256:[0-9a-f]{64}$/u.test(lock.images[name])) throw new Error('Private Cloud candidate image is not digest-pinned: ' + name)
  }
}

function verifyBackupRestore({ operatorBinary, release, config, backup, env }) {
  mkdirSync(backup, { mode: 0o700 })
  const backedUp = operator(operatorBinary, ['backup', '--output', backup], env)
  if (backedUp.receipt?.phase !== 'completed') throw new Error('Private Cloud backup did not complete')
  const tenantVolume = inspectVolume(release, config, 'tenant-data')
  run('docker', ['run', '--rm', '--network', 'none', '-v', tenantVolume + ':/data', infrastructureImage(release, 'alpine'), 'sh', '-ceu', "printf 'mutated' > /data/rc-restore-marker"])
  const restored = operator(operatorBinary, ['restore', '--backup', backup, '--confirm', 'RESTORE:' + backedUp.backupId], env)
  if (restored.receipt?.phase !== 'completed') throw new Error('Private Cloud restore did not complete')
  const marker = run('docker', ['run', '--rm', '--network', 'none', '-v', tenantVolume + ':/data:ro', infrastructureImage(release, 'alpine'), 'sh', '-ceu', 'test ! -e /data/rc-restore-marker']).status
  if (marker !== 0) throw new Error('Private Cloud restore did not replace mutated tenant data')
  return waitForHttp('http://localhost:13001/healthz', 90_000)
}

function verifyMtlsClientRejection(release, config) {
  const invocation = composeInvocation(release, config, ['exec', '-T', 'runtime-host', '/nodejs/bin/node', '-e', `
const https = require('node:https'); const fs = require('node:fs');
const request = https.get({ host: '127.0.0.1', port: 13002, path: '/internal/health', servername: 'runtime-host', ca: fs.readFileSync('/run/kala-secrets/internal_ca.pem'), minVersion: 'TLSv1.3' }, (response) => {
  response.resume(); console.log(JSON.stringify({ rejected: false, status: response.statusCode })); process.exitCode = 2;
});
request.setTimeout(5000, () => request.destroy(new Error('probe timeout')));
request.on('error', (error) => console.log(JSON.stringify({ rejected: true, code: error.code || '', message: error.message })));
`])
  const result = run(invocation.command, invocation.args, false, invocation.env, invocation.cwd)
  const report = json(result.stdout.trim().split(/\r?\n/u).at(-1))
  if (report.rejected !== true || typeof report.message !== 'string' || !/certificate|alert|socket|tls/iu.test(report.message + ' ' + report.code)) throw new Error('Private Cloud Runtime accepted a client without an internal-CA certificate')
}

async function verifyCandidateRuntimeGates({ candidate, config, alicePassword, bobPassword }) {
  const origin = 'http://localhost:13001'
  const marker = 'rc-recovered-' + randomBytes(6).toString('hex')
  const hold = 'rc-hold-' + randomBytes(6).toString('hex')
  const baseline = 'rc-baseline-' + randomBytes(6).toString('hex')
  const chatSession = 'rc-recovery-chat-' + randomBytes(6).toString('hex')
  const dagSession = 'rc-recovery-dag-' + randomBytes(6).toString('hex')
  const aliceArtifactSession = 'rc-quota-alice-' + randomBytes(6).toString('hex')
  const bobArtifactSession = 'rc-quota-bob-' + randomBytes(6).toString('hex')
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/snap/bin/chromium', headless: true, args: ['--no-sandbox'] })
  const actors = []
  let chatSocket
  let dagSocket
  try {
    for (const [name, email, password, sessionId] of [
      ['alice', requiredEnv('PRIVATE_CLOUD_TEST_ALICE_EMAIL'), alicePassword, chatSession],
      ['bob', requiredEnv('PRIVATE_CLOUD_TEST_BOB_EMAIL'), bobPassword, bobArtifactSession],
    ]) {
      const context = await browser.createBrowserContext()
      const page = await context.newPage()
      await loginWithPassword(page, { productOrigin: origin, loginName: email, password })
      const cookie = (await page.cookies()).map((entry) => entry.name + '=' + entry.value).join('; ')
      const socket = connectDashboard(origin, cookie, sessionId)
      await once(socket, 'session:ready', 20_000)
      actors.push({ name, context, page, cookie, socket })
    }
    const alice = actors[0]
    const bob = actors[1]
    assertSocketAck(await socketAck(alice.socket, 'client:create_session', { operationId: operationId(), sessionId: aliceArtifactSession }))
    assertSocketAck(await socketAck(bob.socket, 'client:create_session', { operationId: operationId(), sessionId: bobArtifactSession }))
    const aliceArtifactStatuses = await uploadFixtureBytes(alice.page, aliceArtifactSession, [1048577])
    const bobArtifactStatuses = await uploadFixtureBytes(bob.page, bobArtifactSession, [1])

    const executors = await socketEventAfterEmit(alice.socket, 'server:executors', 'client:list_executors', {}, 15_000)
    const workspace = executors.executors?.find((entry) => entry.workspaceId)
    if (!workspace) throw new Error('Private Cloud recovery acceptance found no tenant Executor')
    assertSocketAck(await socketAck(alice.socket, 'client:create_session', {
      operationId: operationId(), sessionId: chatSession, workspaceId: workspace.workspaceId, workspaceName: workspace.workspaceName,
    }))
    dagSocket = connectDashboard(origin, alice.cookie, dagSession)
    await once(dagSocket, 'session:ready', 20_000)
    assertSocketAck(await socketAck(dagSocket, 'client:create_session', {
      operationId: operationId(), sessionId: dagSession, executionMode: 'dag', workspaceId: workspace.workspaceId, workspaceName: workspace.workspaceName,
    }))
    // External Runtime persists projected state rather than Kernel history events.
    // Persist a unique ordinary user projection to establish a nonzero cursor
    // without coupling Session durability to an unrelated Executor shell turn.
    const baselineObservations = { projections: 0, lastStatus: 'none' }
    alice.socket.on('state:changed', (event) => {
      if (event.sessionId === chatSession) {
        baselineObservations.projections++
        baselineObservations.lastStatus = event.state?.status ?? 'none'
      }
    })
    const baselineProjected = socketEventMatching(alice.socket, 'state:changed', (event) => event.sessionId === chatSession && hasProjectedUserText(event.state, baseline), 60_000)
    assertSocketAck(await socketAck(alice.socket, 'client:user_message', {
      intent: 'text', sessionId: chatSession, text: baseline, mode: 'steer', operationId: operationId(),
    }))
    const cursorBefore = (await baselineProjected.catch(() => {
      throw new Error(`Private Cloud baseline Session projection timed out (projections=${baselineObservations.projections}, lastStatus=${baselineObservations.lastStatus})`)
    })).cursor
    if (!Number.isSafeInteger(cursorBefore) || cursorBefore < 1) throw new Error('Private Cloud recovery Session had no durable projection before restart')
    const initialized = await socketAck(dagSocket, 'client:initialize_dag', {
      operationId: operationId(), sessionId: dagSession, objective: 'Prove a candidate Runtime DAG survives a planned container restart.',
      graph: { expectedGraphVersion: 0, resultNodeId: 'recovery-node', nodes: [{ id: 'recovery-node', title: 'Recovery node', instructions: 'Analyze the phrase runtime restart recovery and reply with one concise sentence.' }], edges: [] },
    }, 20_000)
    assertSocketAck(initialized)
    const dagBefore = await waitFor(async () => {
      const result = await socketAck(dagSocket, 'client:get_dag_run', { sessionId: dagSession }, 10_000)
      return result?.ok && result.value?.events?.some((event) => event.type === 'lease') ? result.value : undefined
    }, 30_000, 'candidate DAG lease')

    // The authenticated fixture holds this real model request for 90 seconds;
    // the follow-up must remain queued through the Runtime stop, not merely ACKed.
    const holdProjected = socketEventMatching(alice.socket, 'state:changed', (event) => event.sessionId === chatSession && event.state?.status === 'thinking' && hasProjectedUserText(event.state, hold), 20_000)
    assertSocketAck(await socketAck(alice.socket, 'client:user_message', {
      intent: 'text', sessionId: chatSession, text: hold, mode: 'steer', operationId: operationId(),
    }))
    await holdProjected
    let markerProjectedBeforeRestart = false
    alice.socket.on('state:changed', (event) => {
      if (event.sessionId === chatSession && hasProjectedUserText(event.state, marker)) markerProjectedBeforeRestart = true
    })
    const queueObserved = socketEventMatching(alice.socket, 'server:message_queue', (event) => event.sessionId === chatSession && event.items?.some((item) => item.text === marker && item.mode === 'queue'), 20_000)
    assertSocketAck(await socketAck(alice.socket, 'client:user_message', {
      intent: 'text', sessionId: chatSession, text: marker, mode: 'queue', operationId: operationId(),
    }))
    await queueObserved
    if (markerProjectedBeforeRestart) throw new Error('Queued message ran before the Runtime restart; recovery was not tested')
    alice.socket.close(); bob.socket.close(); dagSocket.close(); dagSocket = undefined
    const invocation = composeInvocation(candidate, config, ['stop', 'runtime-host'])
    run(invocation.command, invocation.args, false, invocation.env, invocation.cwd)
    const start = composeInvocation(candidate, config, ['start', 'runtime-host'])
    run(start.command, start.args, false, start.env, start.cwd)
    await waitForHttp(origin + '/healthz', 90_000)

    // The ingress health endpoint can recover before Runtime's WebSocket
    // listener. Retry fresh connections after restart; never treat HTTP 200
    // alone as evidence that authenticated Session recovery succeeded.
    const recovered = await connectReadyDashboard(origin, alice.cookie, chatSession, 90_000)
    chatSocket = recovered.socket
    const cursorRecovered = recovered.ready.cursor
    if (!Number.isSafeInteger(cursorRecovered) || cursorRecovered < cursorBefore) throw new Error('Private Cloud recovery Session cursor regressed on first authenticated reconnect')
    if (!hasProjectedUserText(recovered.ready.state, baseline)) throw new Error('Private Cloud recovery lost the baseline Session projection')
    if (hasProjectedUserText(recovered.ready.state, marker)) throw new Error('Queued message dispatched before the Runtime restarted; recovery was not tested')
    // The Host sends the hydrated queue snapshot immediately after session:ready,
    // before draining it. Inspect that first snapshot, not a later empty queue.
    const firstQueue = await waitFor(() => recovered.queues[0], 10_000, 'hydrated queue snapshot after Runtime restart')
    const queueHydratedAfterRestart = firstQueue.sessionId === chatSession && firstQueue.items?.some((item) => item.text === marker && item.mode === 'queue') === true
    if (!queueHydratedAfterRestart) throw new Error('Private Cloud queued message was not hydrated from persistent storage')
    const completed = await waitFor(() => recovered.states.find((event) => event.sessionId === chatSession && event.cursor > cursorRecovered && event.state?.status === 'done' && hasAssistantText(event.state, marker)), 120_000, 'durable queued model response after Runtime restart')
    const cursorAfterMarker = completed.cursor

    const recoveredDag = await connectReadyDashboard(origin, alice.cookie, dagSession, 90_000)
    dagSocket = recoveredDag.socket
    const dagAfterResult = await socketAck(dagSocket, 'client:get_dag_run', { sessionId: dagSession }, 20_000)
    assertSocketAck(dagAfterResult)
    const dagAfter = dagAfterResult.value
    return {
      unitResourceIsolation: { aliceArtifactStatuses, bobArtifactStatuses },
      restartRecovery: {
        queuePersistedBeforeRestart: true,
        queueHydratedAfterRestart,
        queuedMarkerRecovered: true,
        cursorBefore,
        cursorRecovered,
        cursorAfterMarker,
        dagRunIdBefore: dagBefore.id,
        dagRunIdAfter: dagAfter?.id,
        dagLeaseEventsBefore: dagBefore.events.filter((event) => event.type === 'lease').length,
        dagLeaseEventsAfter: dagAfter?.events?.filter((event) => event.type === 'lease').length ?? 0,
      },
    }
  } finally {
    chatSocket?.close(); dagSocket?.close()
    for (const actor of actors) { actor.socket.close(); await actor.context.close().catch(() => undefined) }
    await browser.close()
  }
}

function assertRuntimeGateReport(report) {
  const quota = report?.unitResourceIsolation
  if (JSON.stringify(quota?.aliceArtifactStatuses) !== JSON.stringify([400]) || JSON.stringify(quota?.bobArtifactStatuses) !== JSON.stringify([201])) throw new Error('Private Cloud per-Unit artifact quota did not fail closed without affecting a second Unit')
  const recovery = report?.restartRecovery
  if (recovery?.queuePersistedBeforeRestart !== true || recovery.queueHydratedAfterRestart !== true || recovery.queuedMarkerRecovered !== true || !Number.isSafeInteger(recovery.cursorBefore) || recovery.cursorBefore < 1 || !Number.isSafeInteger(recovery.cursorRecovered) || recovery.cursorRecovered < recovery.cursorBefore || !Number.isSafeInteger(recovery.cursorAfterMarker) || recovery.cursorAfterMarker <= recovery.cursorRecovered) throw new Error('Private Cloud queue or Session cursor did not survive Runtime restart')
  if (!recovery.dagRunIdBefore || recovery.dagRunIdAfter !== recovery.dagRunIdBefore || !Number.isSafeInteger(recovery.dagLeaseEventsBefore) || recovery.dagLeaseEventsBefore < 1 || !Number.isSafeInteger(recovery.dagLeaseEventsAfter) || recovery.dagLeaseEventsAfter < recovery.dagLeaseEventsBefore) throw new Error('Private Cloud DAG lease history did not survive Runtime restart')
}

function connectDashboard(origin, cookie, sessionId) { return io(origin + '/dashboard', { transports: ['websocket'], extraHeaders: { cookie }, auth: { role: 'dashboard', sessionId, clientVersion: '1' }, reconnection: false }) }
async function connectReadyDashboard(origin, cookie, sessionId, timeout) {
  return waitFor(async () => {
    const socket = connectDashboard(origin, cookie, sessionId)
    try {
      const queues = []
      const states = []
      socket.on('server:message_queue', (event) => queues.push(event))
      socket.on('state:changed', (event) => states.push(event))
      const ready = await once(socket, 'session:ready', 5_000)
      return { socket, ready, queues, states }
    } catch {
      socket.close()
      return undefined
    }
  }, timeout, 'authenticated Private Cloud socket recovery')
}
function once(socket, event, timeout) {
  return new Promise((resolveEvent, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off(event, onEvent); socket.off('connect_error', onError); socket.off('disconnect', onError) }
    const onEvent = (value) => { cleanup(); resolveEvent(value) }
    const onError = () => { cleanup(); reject(new Error('Private Cloud socket disconnected before ' + event)) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Private Cloud socket timed out waiting for ' + event)) }, timeout)
    socket.once(event, onEvent)
    socket.once('connect_error', onError)
    socket.once('disconnect', onError)
  })
}
function operationId() { return 'rc-operation-' + randomBytes(12).toString('hex') }
function socketAck(socket, event, payload, timeout = 15_000) { return socket.timeout(timeout).emitWithAck(event, payload) }
function assertSocketAck(value) { if (!value?.ok) throw new Error('Private Cloud Runtime operation failed: ' + String(value?.error)) }
function socketEventAfterEmit(socket, responseEvent, requestEvent, payload, timeout) { const pending = once(socket, responseEvent, timeout); socket.emit(requestEvent, payload); return pending }
function socketEventMatching(socket, event, predicate, timeout) { return new Promise((resolveEvent, reject) => { const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(event + ' timed out')) }, timeout); const listener = (value) => { if (!predicate(value)) return; clearTimeout(timer); socket.off(event, listener); resolveEvent(value) }; socket.on(event, listener) }) }
function hasProjectedUserText(state, text) {
  return state?.messages?.some((message) => message.role === 'user' && message.content?.some((part) => part.type === 'text' && part.text === text)) === true
}
function hasAssistantText(state, text) {
  return state?.messages?.some((message) => message.role === 'assistant' && message.content?.some((part) => part.type === 'text' && part.text === text)) === true
}
async function uploadFixtureBytes(page, sessionId, sizes) { return await page.evaluate(async ({ sessionId, sizes }) => { const statuses = []; for (const size of sizes) { const response = await fetch('/runtime/attachments?sessionId=' + encodeURIComponent(sessionId), { method: 'POST', headers: { 'content-type': 'text/plain', 'x-agent-runlab-attachment-name': encodeURIComponent('quota-' + size + '-' + statuses.length + '.txt') }, body: 'x'.repeat(size) }); statuses.push(response.status) }; return statuses }, { sessionId, sizes }) }

function extract(archive, destination) { mkdirSync(destination, { recursive: true }); run('tar', ['--same-permissions', '-xzf', archive, '-C', destination]); const entries = readdirFlat(destination); const rootEntry = entries.length === 1 && entries[0].directory ? join(destination, entries[0].name) : destination; const manifest = find(rootEntry, 'manifest.json'); return resolve(manifest, '..') }
function readdirFlat(path) { return readdirSync(path, { withFileTypes: true }).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })) }
function find(rootDir, name) { const queue = [rootDir]; while (queue.length) { const current = queue.shift(); for (const entry of readdirSync(current, { withFileTypes: true })) { const path = join(current, entry.name); if (entry.isFile() && entry.name === name) return path; if (entry.isDirectory()) queue.push(path) } }; throw new Error('archive is missing ' + name) }
function verify(path) { const result = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', '--release', path]); if (!json(result.stdout).ok) throw new Error('Private Cloud bundle verification failed') }
function requirePrivateConfig(path) { for (const name of ['deployment.env', 'runtime-provider-catalog.json']) if (!existsSync(join(path, name))) throw new Error('Private Cloud config template is missing ' + name); if (!existsSync(join(path, 'secrets'))) throw new Error('Private Cloud config template is missing secrets') }
function rewriteDeploymentEnv(path, project) { const lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line && !line.startsWith('COMPOSE_PROJECT_NAME=')); lines.push('COMPOSE_PROJECT_NAME=' + project); writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 }) }
function bundleOperator(directory) {
  const js = join(directory, 'kala-private-cloud.mjs')
  const native = join(directory, 'kala-private-cloud')
  if (existsSync(js) === existsSync(native)) throw new Error('Private Cloud bundle must contain exactly one Operator')
  return existsSync(js) ? js : native
}
function operator(binary, args, env) { const result = run(binary.endsWith('.mjs') ? process.execPath : binary, binary.endsWith('.mjs') ? [binary, ...args] : args, false, env); return json(result.stdout) }
function assertServicesReady(services) { for (const name of ['runtime-host', 'runtime-ingress', 'dashboard']) if (services?.[name]?.state !== 'running' || !['', 'healthy'].includes(services[name].health)) throw new Error('Private Cloud service is not ready: ' + name) }
function inspectVolume(release, config, name) { const invocation = composeInvocation(release, config, ['config', '--format', 'json']); const value = json(run(invocation.command, invocation.args, false, invocation.env, invocation.cwd).stdout); return value.volumes?.[name]?.name ?? envFile(join(config, 'deployment.env')).COMPOSE_PROJECT_NAME + '_' + name }
function composeInvocation(release, config, args) { const deployment = envFile(join(config, 'deployment.env')); const storage = deployment.KALA_STORAGE === 'local-volume' ? 'compose.storage-local.yaml' : deployment.KALA_STORAGE === 'external-nfs' ? 'compose.storage-external-nfs.yaml' : 'compose.storage-nfs.yaml'; const profile = deployment.KALA_PROFILE === 'local' ? 'compose.local.yaml' : 'compose.cloudflare.yaml'; const overlays = ['compose.yaml', storage, profile, ...(deployment.KALA_IDENTITY_MODE === 'bundled' ? ['compose.identity-local.yaml'] : [])]; const lock = json(readFileSync(join(release, 'image-lock.json'), 'utf8')); return { command: 'docker', cwd: release, env: { ...process.env, ...deployment, KALA_RUNTIME_IMAGE: lock.images.runtime, KALA_INGRESS_IMAGE: lock.images.ingress, KALA_DASHBOARD_IMAGE: lock.images.dashboard, KALA_SECRETS_DIR: join(config, 'secrets'), KALA_IDENTITY_SECRETS_DIR: join(config, 'identity-secrets'), KALA_PROVIDER_CATALOG_FILE: join(config, 'runtime-provider-catalog.json'), KALA_DEPLOYMENT_CONFIG_FILE: join(release, 'deployment.json') }, args: ['compose', '--project-name', deployment.COMPOSE_PROJECT_NAME, '--env-file', join(config, 'deployment.env'), ...overlays.flatMap((file) => ['-f', join(release, file)]), ...args] } }
function envFile(path) { return Object.fromEntries(readFileSync(path, 'utf8').split(/\r?\n/u).map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u)).filter(Boolean).map((match) => [match[1], match[2]])) }
function infrastructureImage(release, name) { const match = readFileSync(join(release, 'compose.yaml'), 'utf8').match(new RegExp('image: (' + name + '(?::[^\\s@]+)?@sha256:[0-9a-f]{64})', 'u')); if (!match) throw new Error('missing immutable ' + name + ' image'); return match[1] }
function cleanupProject(name) {
  const containers = run('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + name], true).stdout.trim().split(/\s+/u).filter(Boolean)
  if (containers.length) run('docker', ['rm', '-f', ...containers], true)
  const volumes = run('docker', ['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + name], true).stdout.trim().split(/\s+/u).filter(Boolean)
  if (volumes.length) run('docker', ['volume', 'rm', ...volumes], true)
  const networks = run('docker', ['network', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + name], true).stdout.trim().split(/\s+/u).filter(Boolean)
  if (networks.length) run('docker', ['network', 'rm', ...networks], true)
}
async function waitForHttp(url, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { const response = await fetch(url); if (response.ok) return } catch {}; await new Promise((resolveWait) => setTimeout(resolveWait, 500)) }; throw new Error('timed out waiting for ' + url) }
async function waitFor(check, timeout, label) { const deadline = Date.now() + timeout; let last; while (Date.now() < deadline) { try { const value = await check(); if (value) return value } catch (error) { last = error }; await new Promise((resolveWait) => setTimeout(resolveWait, 250)) }; throw new Error('timed out waiting for ' + label + (last ? ': ' + String(last) : '')) }
function run(command, args, allowFailure = false, env = process.env, cwd = root) { const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (result.status !== 0 && !allowFailure) throw new Error(command + ' failed: ' + (result.stderr || result.stdout)); return result }
function json(value) { return JSON.parse(String(value)) }
function digest(value) { return createHash('sha256').update(value).digest('hex') }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error('missing ' + name); return process.argv[index + 1] }
function requiredEnv(name) { const value = process.env[name]?.trim(); if (!value) throw new Error(name + ' is required'); return value }
