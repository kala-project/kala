import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { rootCertificates } from 'node:tls'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const digest = (character) => `sha256:${character.repeat(64)}`
const image = (name, character) => `ghcr.io/example/${name}@${digest(character)}`

test('builds an exact digest-pinned source-free Private Cloud bundle', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-bundle-'))
  const bundle = join(scratch, 'bundle')
  build(bundle, { runtime: image('runtime', 'a'), ingress: image('ingress', 'b'), dashboard: image('dashboard', 'c') })
  const verified = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', bundle])
  assert.equal(JSON.parse(verified.stdout).ok, true)
  const compose = readFileSync(join(bundle, 'compose.postgres-s3-base.yaml'), 'utf8')
  for (const obsolete of ['compose.yaml', 'compose.storage-local.yaml', 'compose.storage-nfs.yaml', 'compose.storage-external-nfs.yaml']) assert.equal(existsSync(join(bundle, obsolete)), false)
  assert.doesNotMatch(compose, /^\s+build:/mu)
  assert.match(compose, /edge: \{ gw_priority: 1 \}/u)
  assert.match(compose, /egress: \{ gw_priority: 1 \}/u)
  assert.equal(readFileSync(join(bundle, 'image-lock.json'), 'utf8').includes(image('dashboard', 'c')), true)
  assert.equal(run(process.execPath, [join(bundle, 'kala-private-cloud.mjs'), '--help']).stdout.includes('upgrade-dashboard'), true)

  writeFileSync(join(bundle, 'compose.postgres-s3-base.yaml'), `${compose}\n# tampered\n`)
  const rejected = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', bundle], { allowFailure: true })
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /integrity failed/u)

  const legacyBundle = join(scratch, 'legacy-bundle')
  build(legacyBundle, { runtime: image('runtime', 'a'), ingress: image('ingress', 'b'), dashboard: image('dashboard', 'c') })
  writeManifestFile(legacyBundle, 'compose.storage-nfs.yaml', 'services: {}\n')
  const obsolete = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', legacyBundle], { allowFailure: true })
  assert.notEqual(obsolete.status, 0)
  assert.match(obsolete.stderr, /obsolete storage asset must not ship/u)
})

test('release verification requires exactly one native Operator while development verification permits JavaScript', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-release-operator-'))
  const images = { runtime: image('runtime', 'a'), ingress: image('ingress', 'b'), dashboard: image('dashboard', 'c') }
  const javascriptBundle = join(scratch, 'javascript')
  build(javascriptBundle, images)
  assert.equal(JSON.parse(run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', javascriptBundle]).stdout).releaseMode, false)
  const javascriptRelease = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', '--release', javascriptBundle], { allowFailure: true })
  assert.notEqual(javascriptRelease.status, 0)
  assert.match(javascriptRelease.stderr, /release bundle must contain exactly the native/u)

  const nodeBundle = join(scratch, 'node')
  build(nodeBundle, images, '1'.repeat(40), process.execPath)
  const nodeRelease = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', '--release', nodeBundle], { allowFailure: true })
  assert.notEqual(nodeRelease.status, 0)
  assert.match(nodeRelease.stderr, /must not be the Node executable/u)

  const shebangFixture = join(scratch, 'shebang-fixture')
  writeFileSync(shebangFixture, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const shebangBundle = join(scratch, 'shebang')
  build(shebangBundle, images, '1'.repeat(40), shebangFixture)
  const shebangRelease = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', '--release', shebangBundle], { allowFailure: true })
  assert.notEqual(shebangRelease.status, 0)
  assert.match(shebangRelease.stderr, /Linux ELF64 x86-64 header/u)

  const nativeFixture = join(scratch, 'elf64-x86-64-header-fixture')
  writeFileSync(nativeFixture, linuxX64ElfHeader(), { mode: 0o755 })
  const nativeBundle = join(scratch, 'native')
  build(nativeBundle, images, '1'.repeat(40), nativeFixture)
  // Release verification proves only the expected ELF header, not Kala program identity.
  assert.equal(JSON.parse(run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', '--release', nativeBundle]).stdout).releaseMode, true)

  const javascriptOperator = join(nativeBundle, 'kala-private-cloud.mjs')
  copyFileSync(join(root, 'scripts/deploy/kala-private-cloud.mjs'), javascriptOperator)
  chmodSync(javascriptOperator, 0o755)
  const manifestPath = join(nativeBundle, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const body = readFileSync(javascriptOperator)
  manifest.files['kala-private-cloud.mjs'] = { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const ambiguousRelease = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', '--release', nativeBundle], { allowFailure: true })
  assert.notEqual(ambiguousRelease.status, 0)
  assert.match(ambiguousRelease.stderr, /exactly one operator executable/u)
})

test('parses service images and rejects wrong lock variables or mutable identity images despite comments', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-compose-images-'))
  const images = { runtime: image('runtime', 'a'), ingress: image('ingress', 'b'), dashboard: image('dashboard', 'c') }

  const wrongVariable = join(scratch, 'wrong-variable')
  build(wrongVariable, images)
  const composePath = join(wrongVariable, 'compose.postgres-s3-base.yaml')
  writeManifestFile(wrongVariable, 'compose.postgres-s3-base.yaml', readFileSync(composePath, 'utf8').replace('${KALA_DASHBOARD_IMAGE:', '${KALA_RUNTIME_IMAGE:') + '\n# KALA_DASHBOARD_IMAGE\n')
  const wrongVariableResult = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', wrongVariable], { allowFailure: true })
  assert.notEqual(wrongVariableResult.status, 0)
  assert.match(wrongVariableResult.stderr, /dashboard does not consume KALA_DASHBOARD_IMAGE/u)

  const mutableIdentity = join(scratch, 'mutable-identity')
  build(mutableIdentity, images)
  const identityPath = join(mutableIdentity, 'compose.identity-local.yaml')
  writeManifestFile(mutableIdentity, 'compose.identity-local.yaml', readFileSync(identityPath, 'utf8').replace(/image: alpine@sha256:[0-9a-f]{64}/u, 'image: alpine:latest'))
  const mutableIdentityResult = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', mutableIdentity], { allowFailure: true })
  assert.notEqual(mutableIdentityResult.status, 0)
  assert.match(mutableIdentityResult.stderr, /bundled identity image is not digest pinned/u)

  const missingImage = join(scratch, 'missing-image')
  build(missingImage, images)
  const missingCompose = readFileSync(join(missingImage, 'compose.postgres-s3-base.yaml'), 'utf8')
  writeManifestFile(missingImage, 'compose.postgres-s3-base.yaml', missingCompose.replace(/image: alpine@sha256:[0-9a-f]{64}/u, '# intentionally missing image'))
  const missingResult = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', missingImage], { allowFailure: true })
  assert.notEqual(missingResult.status, 0)
  assert.match(missingResult.stderr, /service init-app-secrets has no image/u)

  const inherited = join(scratch, 'inherited-image')
  build(inherited, images)
  const inheritedCompose = readFileSync(join(inherited, 'compose.postgres-s3-base.yaml'), 'utf8')
  writeManifestFile(inherited, 'compose.postgres-s3-base.yaml', inheritedCompose.replace('  init-app-secrets:\n', '  init-app-secrets:\n    extends: { file: unverified.yaml, service: image }\n'))
  const inheritedResult = run(process.execPath, ['scripts/release/verify-private-cloud-bundle.mjs', inherited], { allowFailure: true })
  assert.notEqual(inheritedResult.status, 0)
  assert.match(inheritedResult.stderr, /PostgreSQL\/S3 root contains build or extends/u)
})

test('refuses legacy installations without mutating their volumes or Docker project', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-operator-'))
  const first = join(scratch, 'first'); const second = join(scratch, 'second')
  const shared = { runtime: image('runtime', 'a'), ingress: image('ingress', 'b') }
  build(first, { ...shared, dashboard: image('dashboard', 'c') }, '1'.repeat(40))
  build(second, { ...shared, dashboard: image('dashboard', 'd') }, '2'.repeat(40))
  const config = join(scratch, 'config'); mkdirSync(join(config, 'secrets'), { recursive: true, mode: 0o700 })
  const catalog = JSON.parse(readFileSync(join(root, 'deploy/private-cloud/local/runtime-provider-catalog.json'), 'utf8'))
  for (const provider of catalog.providers) provider.baseUrl = 'https://model.example.test/v1'
  writeFileSync(join(config, 'runtime-provider-catalog.json'), JSON.stringify(catalog), { mode: 0o600 })
  for (const name of ['control_postgres_password', 'session_secret', 'ingress_secret', 'oidc_client_id', 'oidc_client_secret', 'llm_api_key', 'internal_ca_key.pem', 'internal_ca.pem', 'runtime_host_key.pem', 'runtime_host.pem', 'ingress_client_key.pem', 'ingress_client.pem', 'runtime_health_key.pem', 'runtime_health.pem']) writeFileSync(join(config, 'secrets', name), `fixture-${name}`, { mode: 0o600 })
  const appPort = await freePort()
  writeFileSync(join(config, 'deployment.env'), `KALA_IDENTITY_MODE=external\nKALA_PROFILE=local\nKALA_STORAGE=local-volume\nCOMPOSE_PROJECT_NAME=runlab-test\nKALA_PUBLIC_URLS=http://localhost:${appPort}\nKALA_PUBLIC_LISTEN=127.0.0.1:${appPort}\nOIDC_ISSUER=https://identity.example.test\nOIDC_DISCOVERY_ORIGIN=https://identity.example.test\n`)
  const oidcCa = join(config, 'oidc-ca.pem'); writeFileSync(oidcCa, `${rootCertificates[0]}\n`, { mode: 0o600 })
  const dockerCapture = join(scratch, 'docker-calls.jsonl')
  const bin = join(scratch, 'bin'); mkdirSync(bin); const docker = join(bin, 'docker')
  writeFileSync(docker, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_CAPTURE,JSON.stringify({args,oidcCa:process.env.KALA_OIDC_CA_FILE,dashboard:process.env.KALA_DASHBOARD_IMAGE})+'\\n');
if(args.includes('exec')){let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{fs.writeFileSync(process.env.PROVISION_CAPTURE,body);console.log(JSON.stringify({organizationId:'org_fixture',runtimeUnitId:'tenant_fixture',alreadyApplied:false}))})}
else if(args.includes('ps')&&args.includes('--format')){
 const suffix=(process.env.KALA_DASHBOARD_IMAGE||'').slice(-8);
 for(const row of [
  {Service:'runtime-host',ID:'runtime-fixed',Image:process.env.KALA_RUNTIME_IMAGE,State:'running',Health:'healthy'},
  {Service:'runtime-ingress',ID:'ingress-fixed',Image:process.env.KALA_INGRESS_IMAGE,State:'running',Health:'healthy'},
  {Service:'dashboard',ID:'dashboard-'+suffix,Image:process.env.KALA_DASHBOARD_IMAGE,State:'running',Health:'healthy'}
 ]) console.log(JSON.stringify(row));
}
`)
  chmodSync(docker, 0o755)
  const provisionCapture = join(scratch, 'provision-input.json')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: join(scratch, 'operator'), PROVISION_CAPTURE: provisionCapture, DOCKER_CAPTURE: dockerCapture }
  const cli = join(first, 'kala-private-cloud.mjs')
  assert.match(readFileSync(cli, 'utf8'), /'runtime-ingress', '\/nodejs\/bin\/node', '-e', bootstrap/u)
  assert.match(readFileSync(cli, 'utf8'), /'stop', 'runtime-ingress', 'runtime-host', 'dashboard', \.\.\.\(bundledIdentity \? \[.*'identity-postgres'.*\] : \[\]\), 'control-postgres'/u)
  const refused = run(process.execPath, [cli, 'install', '--bundle', first, '--config-dir', config], { env, allowFailure: true })
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /new legacy local-volume\/NFS installations are disabled/u)
  assert.equal(existsSync(dockerCapture), false)
  mkdirSync(env.KALA_PRIVATE_CLOUD_OPERATOR_ROOT, { recursive: true })
  const firstLock = JSON.parse(readFileSync(join(first, 'image-lock.json'), 'utf8'))
  writeFileSync(join(env.KALA_PRIVATE_CLOUD_OPERATOR_ROOT, 'installation.json'), JSON.stringify({ schemaVersion: 1, installationId: 'installation-existing-legacy', configDir: config, projectName: 'runlab-test', storageMode: 'local-volume' }))
  writeFileSync(join(env.KALA_PRIVATE_CLOUD_OPERATOR_ROOT, 'active.json'), JSON.stringify({ schemaVersion: 1, releaseId: 'existing-legacy-release', releaseDir: first, version: firstLock.version, revision: firstLock.revision, images: firstLock.images }))
  const record = readFileSync(join(env.KALA_PRIVATE_CLOUD_OPERATOR_ROOT, 'installation.json'), 'utf8')
  for (const [command, args] of [['upgrade-dashboard', ['--bundle', second]], ['rollback', []], ['backup', ['--output', join(scratch, 'backup')]]]) {
    const refusedLegacy = run(process.execPath, [cli, command, ...args], { env, allowFailure: true })
    assert.notEqual(refusedLegacy.status, 0, command)
    assert.match(refusedLegacy.stderr, /legacy Private Cloud installations require their original pinned operator/u)
  }
  assert.equal(readFileSync(join(env.KALA_PRIVATE_CLOUD_OPERATOR_ROOT, 'installation.json'), 'utf8'), record)
  assert.equal(existsSync(dockerCapture), false)
})

function freePort() { return new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) }) }
function linuxX64ElfHeader() {
  const body = Buffer.alloc(64)
  body.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  body.writeUInt16LE(2, 16)
  body.writeUInt16LE(62, 18)
  body.writeUInt32LE(1, 20)
  return body
}
function writeManifestFile(bundle, name, contents) {
  const path = join(bundle, name)
  writeFileSync(path, contents)
  const manifestPath = join(bundle, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const body = readFileSync(path)
  manifest.files[name] = { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
function build(output, images, revision = '1'.repeat(40), operator) {
  const args = ['scripts/release/build-private-cloud-bundle.mjs', '--output', output, '--runtime-image', images.runtime, '--ingress-image', images.ingress, '--dashboard-image', images.dashboard, '--revision', revision]
  if (operator) args.push('--operator', operator)
  run(process.execPath, args)
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: options.env ?? process.env })
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${command} failed: ${result.stderr}`)
  return result
}
