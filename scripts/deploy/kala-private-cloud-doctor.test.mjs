import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const image = (name, character) => `ghcr.io/example/${name}@sha256:${character.repeat(64)}`
const images = { runtime: image('runtime', 'a'), ingress: image('ingress', 'b'), dashboard: image('dashboard', 'c') }
const secretNames = ['control_postgres_password', 'session_secret', 'ingress_secret', 'oidc_client_id', 'oidc_client_secret', 'llm_api_key', 'internal_ca_key.pem', 'internal_ca.pem', 'runtime_host_key.pem', 'runtime_host.pem', 'ingress_client_key.pem', 'ingress_client.pem', 'runtime_health_key.pem', 'runtime_health.pem']
const sensitive = 'SENSITIVE_MODEL_TOKEN_9f51'

test('doctor pulls every digest and checks discovery-origin OIDC, public TLS, and model TLS without credentials', async (t) => {
  const fixture = makeFixture(t)
  const requests = []
  const server = createServer({ key: readFileSync(fixture.serverKey), cert: readFileSync(fixture.serverCert) }, (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, publicHost: request.headers['x-zitadel-public-host'] })
    response.setHeader('content-type', 'application/json')
    if (request.url === '/tenant/.well-known/openid-configuration') response.end(JSON.stringify({ issuer: fixture.issuer, jwks_uri: `${fixture.issuer}/keys` }))
    else if (request.url === '/tenant/keys') response.end(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'one' }] }))
    else response.end('{}')
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => server.close())
  const port = server.address().port
  fixture.issuer = 'https://issuer.example.test/tenant'
  configure(fixture.config, {
    profile: 'cloudflare', publicUrl: `https://127.0.0.1:${port}`, issuer: fixture.issuer,
    discoveryOrigin: `https://127.0.0.1:${port}`, modelUrl: `https://127.0.0.1:${port}/v1`, oidcCa: fixture.ca,
  })

  const result = await runDoctor(fixture, { NODE_EXTRA_CA_CERTS: fixture.ca }, [`https://127.0.0.1:${port}`])
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.checks.every((check) => check.status === 'pass'), true)
  assert.deepEqual(report.checks.filter((check) => check.id.startsWith('registry.')).map((check) => check.target), Object.values(images))
  assert.equal(requests.some((request) => request.url === '/tenant/.well-known/openid-configuration' && request.publicHost === 'issuer.example.test'), true)
  assert.equal(requests.some((request) => request.url === '/tenant/keys'), true)
  assert.equal(requests.some((request) => request.method === 'HEAD' && request.url === '/v1'), true)
  assert.equal(requests.every((request) => request.authorization === undefined), true)
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sensitive, 'u'))
  const pulls = readFileSync(fixture.dockerCapture, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(pulls.map((entry) => entry.args), Object.values(images).map((value) => ['pull', value]))

  const strictModelCa = await runDoctor(fixture, {}, [`https://127.0.0.1:${port}`])
  assert.equal(strictModelCa.code, 1)
  const strictModelCaReport = JSON.parse(strictModelCa.stdout)
  assert.equal(strictModelCaReport.checks.find((check) => check.id === 'oidc.discovery').status, 'pass')
  assert.equal(strictModelCaReport.checks.find((check) => check.id === 'model.test-provider').status, 'fail')

  // Prove oidc-ca.pem itself extends OIDC trust. HTTP checks remain explicit manual,
  // never pass, when trusted TLS cannot be evaluated.
  configure(fixture.config, {
    profile: 'local', publicUrl: 'http://localhost:13001', issuer: fixture.issuer,
    discoveryOrigin: `https://127.0.0.1:${port}`, modelUrl: `http://127.0.0.1:${port}/v1`, oidcCa: fixture.ca,
  })
  const privateCa = await runDoctor(fixture, {}, [`https://127.0.0.1:${port}`])
  assert.equal(privateCa.code, 0, privateCa.stderr)
  const privateCaReport = JSON.parse(privateCa.stdout)
  assert.equal(privateCaReport.checks.find((check) => check.id === 'oidc.discovery').status, 'pass')
  assert.equal(privateCaReport.checks.find((check) => check.id === 'oidc.jwks').status, 'pass')
  assert.equal(privateCaReport.checks.find((check) => check.id === 'public-origin').status, 'manual')
  assert.equal(privateCaReport.checks.find((check) => check.id === 'model.test-provider').status, 'manual')
})

test('doctor reports independent pull and untrusted TLS failures without leaking configured secrets', async (t) => {
  const fixture = makeFixture(t, { failIngress: true })
  const server = createServer({ key: readFileSync(fixture.serverKey), cert: readFileSync(fixture.serverCert) }, (_request, response) => response.end('{}'))
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => server.close())
  const port = server.address().port
  const issuer = `https://127.0.0.1:${port}`
  configure(fixture.config, {
    profile: 'cloudflare', publicUrl: issuer, issuer, discoveryOrigin: issuer,
    modelUrl: `${issuer}/v1?api_key=${sensitive}`, oidcCa: null,
  })

  const result = await runDoctor(fixture, {}, [issuer])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.ok, false)
  assert.equal(report.checks.find((check) => check.id === 'registry.runtime').status, 'pass')
  assert.equal(report.checks.find((check) => check.id === 'registry.ingress').status, 'fail')
  assert.equal(report.checks.find((check) => check.id === 'registry.dashboard').status, 'pass')
  assert.equal(report.checks.find((check) => check.id === 'oidc.discovery').status, 'fail')
  assert.equal(report.checks.find((check) => check.id === 'oidc.jwks').status, 'manual')
  assert.equal(report.checks.find((check) => check.id === 'public-origin').status, 'fail')
  assert.equal(report.checks.find((check) => check.id === 'model.test-provider').status, 'fail')
  assert.match(report.checks.find((check) => check.id === 'registry.ingress').remediation, /Authenticate/u)
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sensitive, 'u'))
})

test('doctor leaves configured private targets manual and makes no request without explicit authorization', async (t) => {
  const fixture = makeFixture(t)
  const requests = []
  const server = createServer({ key: readFileSync(fixture.serverKey), cert: readFileSync(fixture.serverCert) }, (request, response) => {
    requests.push(request.url)
    response.end('{}')
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => server.close())
  const origin = `https://127.0.0.1:${server.address().port}`
  fixture.issuer = 'https://issuer.example.test/tenant'
  configure(fixture.config, {
    profile: 'cloudflare', publicUrl: origin, issuer: fixture.issuer,
    discoveryOrigin: origin, modelUrl: `${origin}/v1`, oidcCa: fixture.ca,
  })

  const result = await runDoctor(fixture, { NODE_EXTRA_CA_CERTS: fixture.ca })
  assert.equal(result.code, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.checks.find((check) => check.id === 'oidc.discovery').status, 'manual')
  assert.equal(report.checks.find((check) => check.id === 'oidc.jwks').status, 'manual')
  assert.equal(report.checks.find((check) => check.id === 'public-origin').status, 'manual')
  assert.equal(report.checks.find((check) => check.id === 'model.test-provider').status, 'manual')
  assert.deepEqual(requests, [])

  const unbound = await runDoctor(fixture, { NODE_EXTRA_CA_CERTS: fixture.ca }, ['https://127.0.0.1:1'])
  assert.equal(unbound.code, 1)
  assert.match(unbound.stderr, /must exactly match a configured/u)
  assert.deepEqual(requests, [])

  const metadataOrigin = 'https://169.254.169.254'
  configure(fixture.config, {
    profile: 'cloudflare', publicUrl: metadataOrigin, issuer: fixture.issuer,
    discoveryOrigin: metadataOrigin, modelUrl: `${metadataOrigin}/v1`, oidcCa: fixture.ca,
  })
  const metadata = await runDoctor(fixture, {}, [metadataOrigin])
  assert.equal(metadata.code, 1)
  const metadataReport = JSON.parse(metadata.stdout)
  assert.equal(metadataReport.checks.find((check) => check.id === 'oidc.discovery').status, 'fail')
  assert.match(metadataReport.checks.find((check) => check.id === 'oidc.discovery').message, /forbidden address/u)
  assert.deepEqual(requests, [])
})

test('doctor rejects private cross-origin JWKS even when that origin is allowed for a configured model and redacts its path', async (t) => {
  const fixture = makeFixture(t)
  const jwksRequests = []
  const jwksServer = createServer({ key: readFileSync(fixture.serverKey), cert: readFileSync(fixture.serverCert) }, (request, response) => {
    jwksRequests.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    response.end(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'unexpected' }] }))
  })
  await new Promise((resolvePromise) => jwksServer.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => jwksServer.close())
  const jwksOrigin = `https://127.0.0.1:${jwksServer.address().port}`
  const discoveryServer = createServer({ key: readFileSync(fixture.serverKey), cert: readFileSync(fixture.serverCert) }, (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/tenant/.well-known/openid-configuration') response.end(JSON.stringify({ issuer: fixture.issuer, jwks_uri: `${jwksOrigin}/keys/${sensitive}?token=${sensitive}` }))
    else response.end('{}')
  })
  await new Promise((resolvePromise) => discoveryServer.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => discoveryServer.close())
  const discoveryOrigin = `https://127.0.0.1:${discoveryServer.address().port}`
  fixture.issuer = 'https://issuer.example.test/tenant'
  configure(fixture.config, {
    profile: 'cloudflare', publicUrl: discoveryOrigin, issuer: fixture.issuer,
    discoveryOrigin, modelUrl: `${jwksOrigin}/v1`, oidcCa: fixture.ca,
  })

  const result = await runDoctor(fixture, { NODE_EXTRA_CA_CERTS: fixture.ca }, [discoveryOrigin, jwksOrigin])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  const jwks = report.checks.find((check) => check.id === 'oidc.jwks')
  assert.equal(jwks.status, 'fail')
  assert.equal(jwks.target, jwksOrigin)
  assert.match(jwks.message, /cross-origin OIDC metadata/u)
  assert.equal(jwksRequests.some((request) => request.method === 'GET'), false)
  assert.equal(jwksRequests.some((request) => request.method === 'HEAD' && request.url === '/v1'), true)
  assert.equal(jwksRequests.every((request) => request.authorization === undefined), true)
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sensitive, 'u'))
})

function makeFixture(t, options = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-doctor-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const bundle = join(scratch, 'bundle')
  const built = spawnSync(process.execPath, ['scripts/release/build-private-cloud-bundle.mjs', '--output', bundle, '--runtime-image', images.runtime, '--ingress-image', images.ingress, '--dashboard-image', images.dashboard, '--revision', '1'.repeat(40)], { cwd: root, encoding: 'utf8' })
  assert.equal(built.status, 0, built.stderr)

  const certs = join(scratch, 'certs'); mkdirSync(certs)
  const ca = join(certs, 'ca.pem'); const caKey = join(certs, 'ca.key'); const serverKey = join(certs, 'server.key'); const csr = join(certs, 'server.csr'); const serverCert = join(certs, 'server.pem'); const ext = join(certs, 'server.ext')
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Doctor Test CA', '-addext', 'basicConstraints=critical,CA:true', '-keyout', caKey, '-out', ca])
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-keyout', serverKey, '-out', csr])
  writeFileSync(ext, 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
  openssl(['x509', '-req', '-days', '1', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-extfile', ext, '-out', serverCert])

  const config = join(scratch, 'config'); const secrets = join(config, 'secrets')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  const installationId = '00000000-0000-4000-8000-000000000001'
  writeFileSync(join(config, 'installation-id'), `${installationId}\n`, { mode: 0o600 })
  writeFileSync(join(config, 'storage-origin.json'), `${JSON.stringify({ schemaVersion: 1, storageMode: 'postgres-s3', installationId })}\n`, { mode: 0o600 })
  const pg = (user, database) => `postgresql://${user}:fixture@db.example.test/${database}?sslmode=require`
  for (const [name, value] of Object.entries({
    control_postgres_migration_owner_url: pg('control_owner', 'runlab_control'),
    control_postgres_writer_url: pg('control_writer', 'runlab_control'),
    runtime_postgres_owner_url: pg('runtime_owner', 'kala_runtime'),
    runtime_postgres_writer_url: pg('runtime_writer', 'kala_runtime'),
    runtime_postgres_reader_url: pg('runtime_reader', 'kala_runtime'),
    runtime_s3_access_key_id: 'runtime-access', runtime_s3_secret_access_key: 'runtime-secret',
    installation_claim_s3_access_key_id: 'claim-access', installation_claim_s3_secret_access_key: 'claim-secret',
  })) writeFileSync(join(secrets, name), value, { mode: 0o600 })
  writeFileSync(join(secrets, 'runtime_state_master_key'), Buffer.alloc(32, 7), { mode: 0o600 })
  for (const name of secretNames) writeFileSync(join(secrets, name), name === 'llm_api_key' ? sensitive : `fixture-${name}`, { mode: 0o600 })
  const bin = join(scratch, 'bin'); mkdirSync(bin)
  const dockerCapture = join(scratch, 'docker.jsonl')
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.DOCKER_CAPTURE,JSON.stringify({args})+'\\n');
if(process.env.FAIL_INGRESS==='1'&&args[1]?.includes('/ingress@')){console.error('registry token=${sensitive} unauthorized');process.exit(1)}
`, { mode: 0o755 })
  chmodSync(join(bin, 'docker'), 0o755)
  return { scratch, bundle, config, bin, dockerCapture, ca, serverKey, serverCert, issuer: '' , failIngress: options.failIngress }
}

function configure(config, values) {
  writeFileSync(join(config, 'deployment.env'), [
    `KALA_PROFILE=${values.profile}`, 'KALA_STORAGE=postgres-s3', 'COMPOSE_PROJECT_NAME=kala-private-cloud-pg-s3-eval-doctor',
    'KALA_IDENTITY_MODE=external', 'KALA_PG_S3_EVALUATION_ACK=1', 'KALA_PG_S3_EXTERNAL_BACKUP_ACK=1',
    'KALA_CONTROL_DML_ROLE=control_writer', 'KALA_RUNTIME_DML_ROLE=runtime_writer', 'KALA_RUNTIME_READER_ROLE=runtime_reader',
    'KALA_S3_ENDPOINT=https://objects.example.test', 'KALA_S3_REGION=test-1', 'KALA_S3_BUCKET=kala-runtime-eval',
    `KALA_PUBLIC_URLS=${values.publicUrl}`, `OIDC_ISSUER=${values.issuer}`, `OIDC_DISCOVERY_ORIGIN=${values.discoveryOrigin}`,
    'KALA_PUBLIC_LISTEN=127.0.0.1:13001', '',
  ].join('\n'), { mode: 0o600 })
  writeFileSync(join(config, 'runtime-provider-catalog.json'), `${JSON.stringify({ version: 1, defaultModel: 'test-provider:test-model', providers: [{ id: 'test-provider', wire: 'openai', baseUrl: values.modelUrl, credentialRef: 'file:llm_api_key', models: [{ id: 'test-model' }] }] }, null, 2)}\n`, { mode: 0o600 })
  const oidcCa = join(config, 'oidc-ca.pem')
  if (values.oidcCa) writeFileSync(oidcCa, readFileSync(values.oidcCa), { mode: 0o600 })
  else rmSync(oidcCa, { force: true })
}

function runDoctor(fixture, extraEnv = {}, allowedPrivateOrigins = []) {
  return new Promise((resolvePromise) => {
    const allowArgs = allowedPrivateOrigins.flatMap((origin) => ['--allow-private-origin', origin])
    const child = spawn(process.execPath, [join(fixture.bundle, 'kala-private-cloud.mjs'), 'doctor', '--bundle', fixture.bundle, '--config-dir', fixture.config, ...allowArgs], {
      cwd: root,
      env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}`, DOCKER_CAPTURE: fixture.dockerCapture, FAIL_INGRESS: fixture.failIngress ? '1' : '0', KALA_PRIVATE_CLOUD_OPERATOR_ROOT: join(fixture.scratch, 'operator'), KALA_PRIVATE_CLOUD_DOCTOR_TIMEOUT_MS: '2000', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''; let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

function openssl(args) {
  const result = spawnSync('openssl', args, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}
