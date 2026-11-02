import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const image = (name, character) => `ghcr.io/example/${name}@sha256:${character.repeat(64)}`

test('PG/S3 initialization reads 0600 file-backed secrets without restoring all root capabilities', () => {
  const compose = readFileSync(join(root, 'deploy/private-cloud/compose.storage-postgres-s3.yaml'), 'utf8')
  const base = readFileSync(join(root, 'deploy/private-cloud/compose.postgres-s3-base.yaml'), 'utf8')
  for (const [source, service, next] of [
    [base, 'control-plane-init', 'runtime-host'],
    [compose, 'fresh-storage-claim', 'init-storage-secrets'],
    [compose, 'runtime-schema-init', 'runtime-host'],
  ]) {
    const block = source.split(`  ${service}:\n`)[1]?.split(`  ${next}:\n`)[0]
    assert.ok(block, `${service} must be present in PG/S3 Compose`)
    assert.match(block, /user: "0:0"/u)
    assert.match(block, /cap_drop: \[ALL\]/u)
    assert.match(block, /cap_add: \[DAC_OVERRIDE\]/u)
    assert.doesNotMatch(block, /privileged: true/u)
  }
  const projections = readFileSync(join(root, 'deploy/private-cloud/compose.storage-postgres-s3.yaml'), 'utf8')
  assert.match(projections, /cp \/run\/kala-installation\/installation-id \/host\/installation-id/u)
  assert.match(projections, /cp \/run\/kala-installation\/installation-id \/gateway\/installation-id/u)
  assert.equal([...projections.matchAll(/KALA_INSTALLATION_ID_FILE: \/run\/kala-secrets\/installation-id/gu)].length, 2)
  const ingress = projections.split('  runtime-ingress:\n')[1]?.split('\nvolumes:\n')[0]
  assert.match(ingress ?? '', /networks: !override\n\s+edge: \{ gw_priority: 1 \}\n\s+runtime: \{\}\n\s+egress: \{\}/u)
})

test('postgres-s3 is an acknowledged fresh evaluation with strict topology and fail-closed lifecycle', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-pg-s3-'))
  const bundle = join(scratch, 'bundle')
  run(process.execPath, ['scripts/release/build-private-cloud-bundle.mjs', '--output', bundle, '--runtime-image', image('runtime', 'a'), '--ingress-image', image('ingress', 'b'), '--dashboard-image', image('dashboard', 'c'), '--revision', '1'.repeat(40)])
  const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'))
  assert.ok(manifest.files['compose.storage-postgres-s3.yaml'])
  assert.ok(manifest.files['compose.postgres-s3-base.yaml'])

  const appPort = await freePort()
  const cli = join(bundle, 'kala-private-cloud.mjs')
  const operatorRoot = join(scratch, 'operator')
  const baseArgs = [cli, 'init-config', '--bundle', bundle, '--profile', 'local', '--identity', 'external', '--storage', 'postgres-s3', '--app-port', String(appPort)]
  const missingAck = run(process.execPath, [...baseArgs, '--config-dir', join(scratch, 'missing-ack')], { env: { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: operatorRoot }, allowFailure: true })
  assert.notEqual(missingAck.status, 0)
  assert.match(missingAck.stderr, /acknowledge-evaluation/u)
  const bundled = run(process.execPath, [cli, 'init-config', '--bundle', bundle, '--config-dir', join(scratch, 'bundled'), '--identity', 'bundled', '--storage', 'postgres-s3', '--acknowledge-evaluation', '--acknowledge-external-backup'], { env: { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: operatorRoot }, allowFailure: true })
  assert.notEqual(bundled.status, 0)
  assert.match(bundled.stderr, /requires --identity external/u)

  const config = join(scratch, 'config')
  const initialized = JSON.parse(run(process.execPath, [...baseArgs, '--config-dir', config, '--acknowledge-evaluation', '--acknowledge-external-backup'], { env: { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: operatorRoot } }).stdout)
  assert.equal(initialized.storage, 'postgres-s3')
  assert.doesNotMatch(readFileSync(join(config, 'deployment.env'), 'utf8'), /KALA_STORAGE=(?:nfs|local-volume)/u)
  assert.equal(existsSync(join(config, 'secrets', 'control_postgres_password')), false)
  assert.equal(initialized.next.some((entry) => entry.includes('32-byte raw')), true)
  assert.equal(existsSync(join(config, 'secrets', 'runtime_state_master_key')), false)
  const origin = JSON.parse(readFileSync(join(config, 'storage-origin.json'), 'utf8'))
  assert.equal(readFileSync(join(config, 'installation-id'), 'utf8').trim(), origin.installationId)

  writeFileSync(join(config, 'deployment.env'), [
    'KALA_PROFILE=local', 'KALA_STORAGE=postgres-s3', 'KALA_IDENTITY_MODE=external', 'COMPOSE_PROJECT_NAME=kala-private-cloud-pg-s3-eval-test',
    'KALA_PG_S3_EVALUATION_ACK=1', 'KALA_PG_S3_EXTERNAL_BACKUP_ACK=1', `KALA_PUBLIC_LISTEN=127.0.0.1:${appPort}`, `KALA_PUBLIC_URLS=http://localhost:${appPort}`,
    'OIDC_ISSUER=https://identity.example.test', 'OIDC_DISCOVERY_ORIGIN=https://identity.example.test',
    'KALA_CONTROL_DML_ROLE=kala_control_writer', 'KALA_RUNTIME_DML_ROLE=kala_runtime_writer', 'KALA_RUNTIME_READER_ROLE=kala_runtime_reader',
    'KALA_S3_ENDPOINT=https://objects.example.test', 'KALA_S3_REGION=test-1', 'KALA_S3_BUCKET=kala-runtime-eval', '',
  ].join('\n'), { mode: 0o600 })
  const secrets = {
    control_postgres_migration_owner_url: 'postgresql://control_owner:owner-pass@control-db.example.test/runlab_control?sslmode=require',
    control_postgres_writer_url: 'postgresql://kala_control_writer:writer-pass@control-db.example.test/runlab_control?sslmode=require',
    runtime_postgres_owner_url: 'postgresql://runtime_owner:owner-pass@runtime-db.example.test/kala_runtime?sslmode=require',
    runtime_postgres_writer_url: 'postgresql://kala_runtime_writer:writer-pass@runtime-db.example.test/kala_runtime?sslmode=require',
    runtime_postgres_reader_url: 'postgresql://kala_runtime_reader:reader-pass@runtime-db.example.test/kala_runtime?sslmode=require',
    runtime_s3_access_key_id: 'fixture-runtime-key', runtime_s3_secret_access_key: 'fixture-runtime-secret',
    installation_claim_s3_access_key_id: 'fixture-bootstrap-key', installation_claim_s3_secret_access_key: 'fixture-bootstrap-secret',
  }
  for (const [name, value] of Object.entries(secrets)) writeFileSync(join(config, 'secrets', name), value, { mode: 0o600 })
  writeFileSync(join(config, 'secrets', 'runtime_state_master_key'), Buffer.alloc(32, 7), { mode: 0o600 })
  for (const [name, value] of [['oidc_client_id', 'real-client'], ['oidc_client_secret', 'real-client-secret'], ['llm_api_key', 'real-provider-key']]) writeFileSync(join(config, 'secrets', name), value, { mode: 0o600 })
  const catalog = JSON.parse(readFileSync(join(config, 'runtime-provider-catalog.json'), 'utf8'))
  for (const provider of catalog.providers) provider.baseUrl = 'https://model.example.test/v1'
  writeFileSync(join(config, 'runtime-provider-catalog.json'), `${JSON.stringify(catalog)}\n`, { mode: 0o600 })

  const rendered = {
    configs: { installation_id: { file: join(config, 'installation-id') } },
    services: {
      'init-app-secrets': { configs: [{ source: 'installation_id', target: '/run/kala-installation/installation-id' }], command: ['/bin/sh', '-ec', 'cp /run/kala-installation/installation-id /host/installation-id\ncp /run/kala-installation/installation-id /gateway/installation-id'] },
      'fresh-storage-claim': { configs: [{ source: 'installation_id' }], environment: { KALA_FRESH_CLAIM_STATE_MASTER_KEY_FILE: '/run/secrets/runtime_state_master_key', KALA_FRESH_CLAIM_S3_ACCESS_KEY_ID_FILE: '/run/secrets/installation_claim_s3_access_key_id', KALA_FRESH_CLAIM_S3_SECRET_ACCESS_KEY_FILE: '/run/secrets/installation_claim_s3_secret_access_key' }, secrets: ['control_postgres_migration_owner_url', 'runtime_postgres_owner_url', 'runtime_state_master_key', 'installation_claim_s3_access_key_id', 'installation_claim_s3_secret_access_key'] },
      'control-plane-init': { environment: { KALA_INGRESS_REQUIRE_EXISTING_DATABASE: '1' }, depends_on: { 'fresh-storage-claim': { condition: 'service_completed_successfully' } }, secrets: [{ source: 'control_postgres_migration_owner_url' }] },
      'runtime-schema-init': { depends_on: { 'fresh-storage-claim': { condition: 'service_completed_successfully' } }, secrets: [{ source: 'runtime_postgres_owner_url' }] },
      'init-storage-secrets': { secrets: ['runtime_postgres_writer_url', 'runtime_postgres_reader_url', 'runtime_state_master_key', 'runtime_s3_access_key_id', 'runtime_s3_secret_access_key'] },
      'runtime-host': { volumes: [{ source: 'host-secrets', target: '/run/kala-secrets' }], tmpfs: ['/var/lib/kala:rw,noexec,size=256m'], environment: { KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING_FILE: '/run/kala-storage/runtime_postgres_writer_url', KALA_RUNTIME_REQUIRE_INSTALLATION_CLAIM: '1', KALA_INSTALLATION_ID_FILE: '/run/kala-secrets/installation-id' } },
      'runtime-ingress': { networks: { edge: {}, runtime: {}, egress: {} }, volumes: [{ source: 'gateway-secrets', target: '/run/kala-secrets' }], environment: { KALA_INGRESS_LOGIN_STATE_STORE_KIND: 'postgres', KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING_FILE: '/run/kala-storage/runtime_postgres_reader_url', KALA_INGRESS_REQUIRE_INSTALLATION_CLAIM: '1', KALA_INSTALLATION_ID_FILE: '/run/kala-secrets/installation-id' } },
    },
  }
  const bin = join(scratch, 'bin'); mkdirSync(bin)
  const capture = join(scratch, 'docker-calls.jsonl')
  const docker = join(bin, 'docker')
  writeFileSync(docker, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.DOCKER_CAPTURE,JSON.stringify(args)+'\\n');
if(args[0]==='--version') console.log('Docker fixture');
else if(args[0]==='info') console.log('"fixture"');
else if(args.includes('version')) console.log('2.24.7');
else if(args.includes('config')&&args.includes('json')) console.log(process.env.RENDERED_CONFIG);
else if(args.includes('logs')) console.log(process.env.DOCKER_CLAIM_LOG||'');
else if(args[0]==='volume'&&args.includes('ls')&&fs.existsSync(process.env.DOCKER_VOLUME_MARKER)) console.log('disposable-secret-volume');
else if(args.includes('up')&&process.env.DOCKER_FAIL_UP==='1'){fs.writeFileSync(process.env.DOCKER_VOLUME_MARKER,'created');process.exit(1)}
else if(args.includes('down')&&args.includes('--volumes')) fs.rmSync(process.env.DOCKER_VOLUME_MARKER,{force:true});
else if(args.includes('ps')&&args.includes('--format')) for(const row of [
  ...(process.env.DOCKER_FAIL_UP==='1' ? [{Service:process.env.DOCKER_FAILED_SERVICE||'fresh-storage-claim',State:process.env.DOCKER_FAILED_SERVICE==='runtime-host'?(process.env.DOCKER_RESTARTING==='1'?'restarting':'running'):'exited',Health:process.env.DOCKER_FAILED_SERVICE==='runtime-host'&&process.env.DOCKER_RESTARTING!=='1'?'unhealthy':'',ExitCode:1}] : []),
  {Service:'runtime-host',ID:'runtime',Image:process.env.KALA_RUNTIME_IMAGE,State:'running',Health:'healthy'},
  {Service:'runtime-ingress',ID:'ingress',Image:process.env.KALA_INGRESS_IMAGE,State:'running',Health:'healthy'},
  {Service:'dashboard',ID:'dashboard',Image:process.env.KALA_DASHBOARD_IMAGE,State:'running',Health:'healthy'}]) console.log(JSON.stringify(row));
`)
  chmodSync(docker, 0o755)
  const volumeMarker = join(scratch, 'disposable-secret-volume')
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: operatorRoot, DOCKER_CAPTURE: capture, DOCKER_VOLUME_MARKER: volumeMarker, RENDERED_CONFIG: JSON.stringify(rendered) }
  const checked = JSON.parse(run(process.execPath, [cli, 'preflight', '--bundle', bundle, '--config-dir', config], { env }).stdout)
  assert.deepEqual(checked.checks.slice(-3), ['compose-override-version', 'postgres-s3-rendered-topology', 'fresh-evaluation-project'])
  const failedInstall = run(process.execPath, [cli, 'install', '--bundle', bundle, '--config-dir', config], { env: {
    ...env, DOCKER_FAIL_UP: '1', KALA_RC_CLAIM_DIAGNOSTICS: '1',
    DOCKER_CLAIM_LOG: 'Error: EACCES: permission denied, open /run/secrets/runtime_postgres_owner_url; password=do-not-disclose',
  }, allowFailure: true })
  assert.notEqual(failedInstall.status, 0)
  assert.match(failedInstall.stderr, /hosted install diagnostic: fresh-storage-claim:private-file-permission/u)
  assert.doesNotMatch(failedInstall.stderr, /do-not-disclose/u)
  assert.equal(existsSync(volumeMarker), false, 'failed install must remove disposable Compose volumes before retry')
  assert.match(readFileSync(capture, 'utf8'), /"ps","--all","--format","json"[\s\S]*"logs","--no-color","--tail","30","fresh-storage-claim"[\s\S]*"down","--remove-orphans","--volumes"/u)
  assert.equal(readFileSync(join(config, 'installation-id'), 'utf8').trim(), origin.installationId)
  const failedNetwork = run(process.execPath, [cli, 'install', '--bundle', bundle, '--config-dir', config], { env: {
    ...env, DOCKER_FAIL_UP: '1', KALA_RC_CLAIM_DIAGNOSTICS: '1',
    DOCKER_CLAIM_LOG: 'Error: Connection terminated due to connection timeout; secret=do-not-disclose',
  }, allowFailure: true })
  assert.notEqual(failedNetwork.status, 0)
  assert.match(failedNetwork.stderr, /hosted install diagnostic: fresh-storage-claim:network/u)
  assert.doesNotMatch(failedNetwork.stderr, /do-not-disclose/u)
  const failedRuntime = run(process.execPath, [cli, 'install', '--bundle', bundle, '--config-dir', config], { env: {
    ...env, DOCKER_FAIL_UP: '1', DOCKER_FAILED_SERVICE: 'runtime-host', KALA_RC_CLAIM_DIAGNOSTICS: '1',
    DOCKER_CLAIM_LOG: 'Error: EHOSTUNREACH; secret=do-not-disclose',
  }, allowFailure: true })
  assert.notEqual(failedRuntime.status, 0)
  assert.match(failedRuntime.stderr, /hosted install diagnostic: runtime-host:network/u)
  assert.doesNotMatch(failedRuntime.stderr, /do-not-disclose/u)
  assert.match(readFileSync(capture, 'utf8'), /"logs","--no-color","--tail","30","runtime-host"/u)
  const restartingRuntime = run(process.execPath, [cli, 'install', '--bundle', bundle, '--config-dir', config], { env: {
    ...env, DOCKER_FAIL_UP: '1', DOCKER_FAILED_SERVICE: 'runtime-host', DOCKER_RESTARTING: '1', KALA_RC_CLAIM_DIAGNOSTICS: '1',
    DOCKER_CLAIM_LOG: 'Error: ECONNRESET; secret=do-not-disclose',
  }, allowFailure: true })
  assert.notEqual(restartingRuntime.status, 0)
  assert.match(restartingRuntime.stderr, /hosted install diagnostic: runtime-host:network/u)
  assert.doesNotMatch(restartingRuntime.stderr, /do-not-disclose/u)
  const inconclusive = run(process.execPath, [cli, 'install', '--bundle', bundle, '--config-dir', config], { env: {
    ...env, DOCKER_FAIL_UP: '1', DOCKER_FAILED_SERVICE: 'unknown', KALA_RC_CLAIM_DIAGNOSTICS: '1',
    DOCKER_CLAIM_LOG: 'Error: ECONNRESET; secret=do-not-disclose',
  }, allowFailure: true })
  assert.notEqual(inconclusive.status, 0)
  assert.match(inconclusive.stderr, /hosted install diagnostic: status-inconclusive:runtime-host:network/u)
  assert.doesNotMatch(inconclusive.stderr, /do-not-disclose/u)
  const installed = JSON.parse(run(process.execPath, [cli, 'install', '--bundle', bundle, '--config-dir', config], { env }).stdout)
  assert.equal(installed.receipt.phase, 'completed')
  assert.equal(installed.installation.installationId, origin.installationId)
  const callsBeforeRefusals = readFileSync(capture, 'utf8')
  assert.match(callsBeforeRefusals, /compose\.postgres-s3-base\.yaml/u)
  assert.doesNotMatch(callsBeforeRefusals, /"-f","[^"]*\/compose\.yaml"/u)
  for (const [command, args] of [['upgrade', ['--bundle', bundle]], ['upgrade-dashboard', ['--bundle', bundle]], ['rollback', []], ['backup', ['--output', join(scratch, 'backup')]], ['restore', ['--backup', join(scratch, 'missing'), '--confirm', 'RESTORE:missing']], ['uninstall', ['--confirm', `UNINSTALL:${installed.installation.installationId}`]]]) {
    const refused = run(process.execPath, [cli, command, ...args], { env, allowFailure: true })
    assert.notEqual(refused.status, 0, command)
    assert.match(refused.stderr, /postgres-s3 evaluation refuses/u, command)
  }
  assert.equal(readFileSync(capture, 'utf8'), callsBeforeRefusals)
  const installationPath = join(operatorRoot, 'installation.json')
  const installationRecord = JSON.parse(readFileSync(installationPath, 'utf8'))
  writeFileSync(installationPath, `${JSON.stringify({ ...installationRecord, storageMode: 'local-volume' }, null, 2)}\n`, { mode: 0o600 })
  const switchedLegacy = run(process.execPath, [cli, 'backup', '--output', join(scratch, 'switched-backup')], { env, allowFailure: true })
  assert.notEqual(switchedLegacy.status, 0)
  assert.match(switchedLegacy.stderr, /storage mode differs.*leave legacy volumes untouched/u)
  assert.equal(readFileSync(capture, 'utf8'), callsBeforeRefusals)
})

function freePort() { return new Promise((resolvePromise, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolvePromise(port)) }) }) }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: options.env ?? process.env })
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${command} failed: ${result.stderr}`)
  return result
}
