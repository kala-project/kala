#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer-core'
import { createRequire } from 'node:module'
import { createAuthority, s3Client, verifyHttps } from './private-cloud-hosted-tls.mjs'

const root = resolve(import.meta.dirname, '../..')
const postgres = 'postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193'
const zitadel = 'ghcr.io/zitadel/zitadel@sha256:15543f7a80c3e37905fe8c7db56af7ed2a9ece256704322c1449d7e8453afdab'
const login = 'ghcr.io/zitadel/zitadel-login@sha256:adeba50a8090d1484a312ac81e67cae5f839ba376e3325c00ec75fc79939a842'
const caddy = 'caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d'
const alpine = 'alpine@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412'
const seaweed = 'chrislusf/seaweedfs@sha256:c2658820e763294a9e9de7b36c81e59b879e3459148351aee4e31a126ca64860'
const requireHost = createRequire(join(root, 'packages/host/package.json'))
if (process.argv.includes('--internal-render-identity-overlay')) {
  process.stdout.write(renderIdentityOverlay(readFileSync(0, 'utf8'), '192.0.2.1'))
  process.exit(0)
}
if (process.argv.includes('--internal-render-identity-caddy')) {
  process.stdout.write(renderIdentityCaddyfile(readFileSync(0, 'utf8')))
  process.exit(0)
}
if (process.argv.includes('--internal-docker-config-directory')) {
  process.stdout.write(dockerConfigDirectory(process.env) + '\n')
  process.exit(0)
}
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('External authorities may only be provisioned on a fresh GitHub-hosted runner')
const suffix = randomBytes(6).toString('hex')
const scratch = mkdtempSync(join(root, '.runlab-rc-authorities-'))
const identityProject = `runlab-rc-identity-${suffix}`
const postgresProject = `runlab-rc-postgres-${suffix}`
const s3Project = `runlab-rc-s3-${suffix}`
const sharedNetwork = `runlab-rc-egress-${suffix}`
const identityDir = join(scratch, 'identity')
const pgDir = join(scratch, 'postgres')
const s3Dir = join(scratch, 's3')
const identityFile = join(identityDir, 'compose.identity-local.yaml')
const pgFile = join(pgDir, 'compose.json')
const s3File = join(s3Dir, 'compose.json')
const env = { ...process.env }
let sharedNetworkCreated = false

try {
  const bundle = resolve(required('--bundle'))
  for (const image of [postgres, zitadel, login, caddy, alpine, seaweed]) verifyRegistryImage(image)
  const overlay = readFileSync(join(bundle, 'compose.identity-local.yaml'), 'utf8')
  for (const image of [postgres, zitadel, login, caddy, alpine]) if (!overlay.includes('image: ' + image)) throw new Error('Signed candidate does not include the reviewed official identity/PostgreSQL digests')
  const bridge = JSON.parse(run('docker', ['network', 'inspect', 'bridge']).stdout)[0]?.IPAM?.Config?.[0]?.Gateway
  if (!/^172\.(?:1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}$/u.test(bridge ?? '')) throw new Error('Hosted Docker bridge gateway is not a private 172.16/12 address')
  run('docker', ['network', 'create', sharedNetwork], env)
  sharedNetworkCreated = true
  const sharedIpam = JSON.parse(run('docker', ['network', 'inspect', sharedNetwork], env).stdout)[0]?.IPAM?.Config?.[0]
  const sharedGateway = sharedIpam?.Gateway
  if (!/^172\.(?:1[6-9]|2[0-9]|3[01])\.\d{1,3}\.1$/u.test(sharedGateway ?? '')
    || !/\/(?:1[6-9]|2[0-7])$/u.test(sharedIpam?.Subnet ?? '')) {
    throw new Error('Hosted shared egress network must have a private 172.16/12 subnet with room for isolated authorities')
  }
  run('docker', ['network', 'rm', sharedNetwork], env)
  sharedNetworkCreated = false
  run('docker', ['network', 'create', '--subnet', sharedIpam.Subnet, '--gateway', sharedGateway, sharedNetwork], env)
  sharedNetworkCreated = true
  const configuredGateway = JSON.parse(run('docker', ['network', 'inspect', sharedNetwork], env).stdout)[0]?.IPAM?.Config?.[0]?.Gateway
  if (configuredGateway !== sharedGateway) throw new Error('Configured shared egress subnet changed its private gateway')
  const sharedPrefix = sharedGateway.slice(0, -1)
  const sharedIps = { postgres: `${sharedPrefix}20`, identity: `${sharedPrefix}21`, s3: `${sharedPrefix}22` }
  const attachAuthority = (compose, service, ip) => {
    const container = run('docker', [...compose, 'ps', '-q', service], env).stdout.trim()
    if (!/^[0-9a-f]{12,64}$/u.test(container)) throw new Error('Hosted external authority container is missing')
    run('docker', ['network', 'connect', '--ip', ip, sharedNetwork, container], env)
  }
  mkdirSync(identityDir, { mode: 0o700 })
  mkdirSync(pgDir, { mode: 0o700 })
  mkdirSync(s3Dir, { mode: 0o700 })
  const identityTls = createAuthority(join(identityDir, 'tls'), 'oidc', sharedIps.identity, bridge)
  const proxyTlsDir = proxyCertificateDir(identityDir, identityTls)
  const s3Tls = createAuthority(join(s3Dir, 'tls'), 's3', sharedIps.s3, bridge)
  const s3ProxyTlsDir = proxyCertificateDir(s3Dir, s3Tls)
  env.NODE_EXTRA_CA_CERTS = identityTls.ca
  const identitySecrets = join(identityDir, 'identity-secrets')
  mkdirSync(identitySecrets, { mode: 0o700 })
  for (const [name, value] of Object.entries({
    postgres_password: randomBytes(36).toString('base64url'),
    zitadel_masterkey: randomBytes(24).toString('base64url'),
    initial_human_password: 'A1!' + randomBytes(24).toString('base64url'),
  })) privateFile(join(identitySecrets, name), value)
  const caddyfile = readFileSync(join(bundle, 'identity-local.Caddyfile'), 'utf8')
  writeFileSync(join(identityDir, 'identity-local.Caddyfile'), renderIdentityCaddyfile(caddyfile))
  chmodSync(join(identityDir, 'identity-local.Caddyfile'), 0o644)
  writeFileSync(identityFile, renderIdentityOverlay(overlay, bridge, proxyTlsDir))
  Object.assign(env, { KALA_IDENTITY_SECRETS_DIR: identitySecrets, KALA_IDENTITY_PORT: '13002' })

  const adminPassword = randomBytes(36).toString('base64url')
  privateFile(join(pgDir, 'admin-password'), adminPassword)
  const pgPort = String(23000 + randomBytes(2).readUInt16BE() % 16000)
  writeFileSync(pgFile, JSON.stringify({
    services: {
      'external-postgres': {
        image: postgres,
        environment: { POSTGRES_PASSWORD_FILE: '/run/secrets/admin-password', POSTGRES_INITDB_ARGS: '--auth-host=scram-sha-256' },
        secrets: ['admin-password'],
        ports: [`${bridge}:${pgPort}:5432`],
        volumes: ['data:/var/lib/postgresql/data'],
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U postgres'], interval: '5s', timeout: '5s', retries: 30 },
        security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'], cap_add: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'],
      },
    },
    volumes: { data: {} },
    secrets: { 'admin-password': { file: join(pgDir, 'admin-password') } },
  }))
  const pgCompose = ['compose', '--project-name', postgresProject, '-f', pgFile]
  run('docker', [...pgCompose, 'up', '-d', '--wait'], env)
  attachAuthority(pgCompose, 'external-postgres', sharedIps.postgres)
  const roles = Object.fromEntries(['control_owner', 'control_writer', 'runtime_owner', 'runtime_writer', 'runtime_reader']
    .map((role) => [role, randomBytes(36).toString('base64url')]))
  const sql = Object.entries(roles).map(([role, password]) => `CREATE ROLE kala_${role} LOGIN PASSWORD '${password}';`).join('\n')
    + '\nCREATE DATABASE runlab_control OWNER kala_control_owner;\nCREATE DATABASE runlab_runtime OWNER kala_runtime_owner;\n'
    + 'REVOKE ALL ON DATABASE runlab_control FROM PUBLIC;\nREVOKE ALL ON DATABASE runlab_runtime FROM PUBLIC;\n'
    + 'GRANT CONNECT ON DATABASE runlab_control TO kala_control_writer;\n'
    + 'GRANT CONNECT ON DATABASE runlab_runtime TO kala_runtime_writer, kala_runtime_reader;\n'
  run('docker', [...pgCompose, 'exec', '-T', '-u', 'postgres', 'external-postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres'], env, sql)

  const identityCompose = ['compose', '--project-name', identityProject, '-f', identityFile]
  run('docker', [...identityCompose, 'up', '-d', 'identity-proxy'], env)
  attachAuthority(identityCompose, 'identity-proxy', sharedIps.identity)
  try {
    await waitFor('https://localhost:13002/debug/healthz', identityTls.ca, 120_000)
  } catch (error) {
    const proxyLogs = run('docker', [...identityCompose, 'logs', '--no-color', '--tail', '30', 'identity-proxy'], env).stdout
    const diagnostics = ['permission denied', 'no such file', 'address already in use', 'certificate', 'tls', 'caddyfile', 'error']
      .filter((term) => proxyLogs.toLowerCase().includes(term))
    throw new Error(`${error instanceof Error ? error.message : String(error)}; containers=${JSON.stringify(authorityContainerStates(identityCompose, env))}; proxyDiagnostics=${diagnostics.join(',')}`)
  }
  const verifiedDiscovery = JSON.parse(await verifyHttps('https://localhost:13002/.well-known/openid-configuration', identityTls.ca))
  if (verifiedDiscovery.issuer !== 'https://localhost:13002') throw new Error('Independent TLS-verified OIDC discovery issuer mismatch')
  const bootstrap = join(identityDir, 'bootstrap')
  const bootstrapSecrets = join(bootstrap, 'secrets')
  mkdirSync(bootstrapSecrets, { recursive: true, mode: 0o700 })
  privateFile(join(bootstrapSecrets, 'oidc_client_id'), 'REPLACE_WITH_EXTERNAL_OIDC_CLIENT_ID')
  privateFile(join(bootstrapSecrets, 'oidc_client_secret'), 'REPLACE_WITH_EXTERNAL_OIDC_CLIENT_SECRET')
  privateFile(join(bootstrap, 'deployment.env'),
    'KALA_PUBLIC_URLS=http://localhost:13001\nKALA_PUBLIC_LISTEN=127.0.0.1:13001\n'
    + `KALA_IDENTITY_MODE=external\nKALA_IDENTITY_PORT=13002\nOIDC_ISSUER=https://localhost:13002\nOIDC_DISCOVERY_ORIGIN=https://${bridge}:13002\n`)
  const users = ['alice', 'bob'].map((name) => ({
    name, email: `${name}-${suffix}@example.test`,
    password: `${name === 'alice' ? 'A' : 'B'}a1!${randomBytes(30).toString('base64url')}`,
  }))
  const usersFile = join(bootstrap, 'users.json')
  privateFile(usersFile, JSON.stringify({ users }))
  const volumes = JSON.parse(run('docker', [...identityCompose, 'config', '--format', 'json'], env).stdout).volumes
  const enrolled = JSON.parse(run(process.execPath, [
    join(bundle, 'bootstrap-private-cloud-identity.mjs'), '--config-dir', bootstrap,
    '--bootstrap-volume', volumes['identity-zitadel-bootstrap']?.name,
    '--identity-image', alpine,
    '--acceptance-users-file', usersFile, '--external-request-port', '13003',
  ], env).stdout)
  const identities = enrolled.acceptanceUsers ?? []
  if (identities.length !== 2 || identities.some((user, index) => user.email !== users[index].email || !user.subject) || identities[0].subject === identities[1].subject) throw new Error('Independent OIDC failed to enroll two exact real issuer/subject identities')
  const discovery = JSON.parse(await verifyHttps('https://localhost:13002/.well-known/openid-configuration', identityTls.ca))
  if (discovery.issuer !== 'https://localhost:13002') throw new Error('Independent OIDC discovery issuer mismatch')
  const credentials = Object.fromEntries(['admin', 'runtime', 'claim'].map((name) =>
    [name, { accessKeyId: randomBytes(20).toString('hex'), secretAccessKey: randomBytes(36).toString('base64url') }]))
  const bucket = `runlab-rc-${suffix}`
  privateFile(join(s3Dir, 'identities.json'), JSON.stringify({ identities: Object.entries(credentials).map(([name, value]) => ({
    name: `runlab_${name}`, credentials: [{ accessKey: value.accessKeyId, secretKey: value.secretAccessKey }],
    actions: name === 'admin'
      ? [`Admin:${bucket}`, `Read:${bucket}`, `Write:${bucket}`, `List:${bucket}`]
      : [`Read:${bucket}`, `Write:${bucket}`, `List:${bucket}`],
  })) }))
  run('sudo', ['-n', 'chown', '1000:1000', join(s3Dir, 'identities.json')], env)
  writeFileSync(join(s3Dir, 'Caddyfile'),
    ':8443 {\n tls /run/tls/leaf.pem /run/tls/leaf-key.pem\n reverse_proxy external-s3:8333\n}\n')
  writeFileSync(s3File, JSON.stringify({
    services: {
      'external-s3': {
        image: seaweed,
        command: ['server', '-s3', '-s3.config=/run/identity/identities.json', '-ip=external-s3',
          '-master.port=9333', '-volume.port=8080', '-filer.port=8888', '-s3.port=8333'],
        volumes: ['data:/data', `${join(s3Dir, 'identities.json')}:/run/identity/identities.json:ro`],
        networks: ['s3'],
        security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'], cap_add: ['CHOWN', 'SETGID', 'SETUID'],
      },
      'external-s3-tls': {
        image: caddy, user: `${process.getuid()}:${process.getgid()}`, depends_on: ['external-s3'],
        ports: [`127.0.0.1:19000:8443`, `${bridge}:19000:8443`],
        volumes: [`${join(s3Dir, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, `${s3ProxyTlsDir}:/run/tls:ro`],
        networks: ['s3'], read_only: true, tmpfs: ['/config:rw,noexec,nosuid', '/data:rw,noexec,nosuid'],
        security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'], cap_add: ['NET_BIND_SERVICE'],
      },
    },
    networks: { s3: {} }, volumes: { data: {} },
  }))
  const s3Compose = ['compose', '--project-name', s3Project, '-f', s3File]
  run('docker', [...s3Compose, 'up', '-d'], env)
  attachAuthority(s3Compose, 'external-s3-tls', sharedIps.s3)
  const { CreateBucketCommand, PutBucketPolicyCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = requireHost('@aws-sdk/client-s3')
  const endpoint = `https://${sharedIps.s3}:8443`
  const admin = s3Client(endpoint, 'us-east-1', credentials.admin, s3Tls.ca)
  const runtime = s3Client(endpoint, 'us-east-1', credentials.runtime, s3Tls.ca)
  const claim = s3Client(endpoint, 'us-east-1', credentials.claim, s3Tls.ca)
  try {
    await waitForS3(admin, bucket, CreateBucketCommand)
  } catch (error) {
    const logs = run('docker', [...s3Compose, 'logs', '--no-color', '--tail', '30', 'external-s3', 'external-s3-tls'], env).stdout.toLowerCase()
    const diagnostics = ['permission denied', 'access denied', 'invalid', 'no such file', 'address already in use', 'certificate', 'tls', 'error']
      .filter((term) => logs.includes(term))
    throw new Error(`${error instanceof Error ? error.message : String(error)}; containers=${JSON.stringify(authorityContainerStates(s3Compose, env))}; s3Diagnostics=${diagnostics.join(',')}`)
  }
  const arn = `arn:aws:s3:::${bucket}`
  await admin.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify({
    Version: '2012-10-17', Statement: [
      { Effect: 'Deny', Principal: { AWS: 'arn:aws:iam::000000000000:user/runlab_runtime' },
        Action: ['s3:PutObject', 's3:DeleteObject'], Resource: [`${arn}/_kala/installation-claim.json`, `${arn}/_kala/recovery-checkpoint.json`] },
      { Effect: 'Deny', Principal: { AWS: 'arn:aws:iam::000000000000:user/runlab_claim' },
        Action: 's3:PutObject', NotResource: [`${arn}/_kala/installation-claim.json`, `${arn}/_kala/recovery-checkpoint.json`] },
      { Effect: 'Deny', Principal: { AWS: 'arn:aws:iam::000000000000:user/runlab_claim' },
        Action: 's3:DeleteObject', Resource: `${arn}/*` },
    ],
  }) }))
  for (const key of ['_kala/installation-claim.json', '_kala/recovery-checkpoint.json']) {
    await claim.send(new PutObjectCommand({ Bucket: bucket, Key: key, IfNoneMatch: '*', Body: 'authorization-probe' }))
    await expectPreconditionFailed(() => claim.send(new PutObjectCommand({ Bucket: bucket, Key: key, IfNoneMatch: '*', Body: 'must-not-overwrite' })))
  }
  await runtime.send(new GetObjectCommand({ Bucket: bucket, Key: '_kala/installation-claim.json' }))
  await expectDenied(() => runtime.send(new DeleteObjectCommand({ Bucket: bucket, Key: '_kala/installation-claim.json' })))
  await expectDenied(() => runtime.send(new PutObjectCommand({ Bucket: bucket, Key: '_kala/installation-claim.json', Body: 'forbidden' })))
  await expectDenied(() => runtime.send(new PutObjectCommand({ Bucket: bucket, Key: '_kala/recovery-checkpoint.json', Body: 'forbidden' })))
  await expectDenied(() => claim.send(new PutObjectCommand({ Bucket: bucket, Key: 'application/probe', Body: 'forbidden' })))
  await expectDenied(() => claim.send(new DeleteObjectCommand({ Bucket: bucket, Key: '_kala/installation-claim.json' })))
  await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: '_kala/installation-claim.json' }))
  await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: '_kala/recovery-checkpoint.json' }))
  await runtime.send(new PutObjectCommand({ Bucket: bucket, Key: 'application/probe', Body: 'authorized' }))
  await admin.send(new DeleteObjectCommand({ Bucket: bucket, Key: 'application/probe' }))
  await Promise.all([admin.destroy(), runtime.destroy(), claim.destroy()])

  const config = join(scratch, 'candidate-config')
  const operator = join(bundle, 'kala-private-cloud.mjs')
  const nativeOperator = join(bundle, 'kala-private-cloud')
  const binary = existsSync(operator) ? operator : nativeOperator
  if (existsSync(operator) === existsSync(nativeOperator)) throw new Error('Signed candidate must include exactly one Operator')
  run(binary.endsWith('.mjs') ? process.execPath : binary,
    [...(binary.endsWith('.mjs') ? [binary] : []), 'init-config', '--bundle', bundle, '--config-dir', config,
      '--profile', 'local', '--identity', 'external', '--storage', 'postgres-s3',
      '--acknowledge-evaluation', '--acknowledge-external-backup'],
    { ...env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: join(scratch, 'operator-init') })
  const appSecrets = join(config, 'secrets')
  for (const [role, file, database] of [
    ['control_owner', 'control_postgres_migration_owner_url', 'runlab_control'],
    ['control_writer', 'control_postgres_writer_url', 'runlab_control'],
    ['runtime_owner', 'runtime_postgres_owner_url', 'runlab_runtime'],
    ['runtime_writer', 'runtime_postgres_writer_url', 'runlab_runtime'],
    ['runtime_reader', 'runtime_postgres_reader_url', 'runlab_runtime'],
  ]) privateReplace(join(appSecrets, file), `postgresql://kala_${role}:${encodeURIComponent(roles[role])}@${sharedIps.postgres}:5432/${database}?sslmode=disable`)
  privateReplace(join(appSecrets, 'runtime_state_master_key'), randomBytes(32))
  for (const name of ['oidc_client_id', 'oidc_client_secret']) privateReplace(join(appSecrets, name), readFileSync(join(bootstrapSecrets, name)))
  for (const [name, value] of Object.entries({
    runtime_s3_access_key_id: credentials.runtime.accessKeyId,
    runtime_s3_secret_access_key: credentials.runtime.secretAccessKey,
    installation_claim_s3_access_key_id: credentials.claim.accessKeyId,
    installation_claim_s3_secret_access_key: credentials.claim.secretAccessKey,
  })) privateReplace(join(appSecrets, name), value)
  for (const [name, source] of [['oidc-ca.pem', identityTls.ca], ['s3-ca.pem', s3Tls.ca]]) {
    cpSync(source, join(config, name)); chmodSync(join(config, name), 0o600)
  }
  writeFileSync(join(config, 'deployment.env'), readFileSync(join(config, 'deployment.env'), 'utf8')
    + `\nOIDC_ISSUER=https://localhost:13002\nOIDC_DISCOVERY_ORIGIN=https://${sharedIps.identity}:8443\n`
    + `KALA_RC_EGRESS_NETWORK=${sharedNetwork}\nKALA_RC_EGRESS_EXTERNAL=true\n`
    + `KALA_S3_ENDPOINT=${endpoint}\nKALA_S3_REGION=us-east-1\nKALA_S3_BUCKET=${bucket}\nKALA_S3_FORCE_PATH_STYLE=true\n`
    + 'KALA_CONTROL_DML_ROLE=kala_control_writer\nKALA_RUNTIME_DML_ROLE=kala_runtime_writer\nKALA_RUNTIME_READER_ROLE=kala_runtime_reader\n',
  { mode: 0o600 })
  const home = join(scratch, 'browser-home')
  const nss = join(home, '.pki', 'nssdb')
  mkdirSync(nss, { recursive: true, mode: 0o700 })
  run('certutil', ['-d', `sql:${nss}`, '-N', '--empty-password'])
  run('certutil', ['-d', `sql:${nss}`, '-A', '-n', 'Runlab isolated OIDC CA', '-t', 'C,,', '-i', identityTls.ca])
  const browser = await puppeteer.launch({ executablePath: env.CHROME_PATH, headless: true, args: ['--no-sandbox'], env: { ...env, HOME: home } })
  try {
    const page = await browser.newPage()
    const response = await page.goto('https://localhost:13002/.well-known/openid-configuration')
    if (!response?.ok() || (await response.json()).issuer !== 'https://localhost:13002') throw new Error('Chromium did not verify the isolated OIDC TLS issuer')
  } finally { await browser.close() }
  const containerName = (compose, service) => run('docker', ['inspect', '--format', '{{.Name}}',
    run('docker', [...compose, 'ps', '-q', service], env).stdout.trim()]).stdout.trim().slice(1)
  const authorityContainers = [
    containerName(identityCompose, 'identity-zitadel'), containerName(identityCompose, 'identity-postgres'),
    containerName(pgCompose, 'external-postgres'), containerName(s3Compose, 'external-s3'),
    containerName(identityCompose, 'identity-login'), containerName(identityCompose, 'identity-proxy'),
    containerName(s3Compose, 'external-s3-tls'),
  ]
  const acceptanceEnv = { ...env, HOME: home, NODE_EXTRA_CA_CERTS: identityTls.ca,
    DOCKER_CONFIG: dockerConfigDirectory(env),
    KALA_RC_CLAIM_DIAGNOSTICS: '1',
    KALA_RC_PRIVATE_CLOUD_CONFIG_TEMPLATE: config,
    PRIVATE_CLOUD_EXTERNAL_AUTHORITY_CONTAINERS: authorityContainers.join(','),
    PRIVATE_CLOUD_EXTERNAL_POSTGRES_IMAGE: postgres,
    PRIVATE_CLOUD_EXTERNAL_S3_BACKUP_ACCESS_KEY_ID: credentials.admin.accessKeyId,
    PRIVATE_CLOUD_EXTERNAL_S3_BACKUP_SECRET_ACCESS_KEY: credentials.admin.secretAccessKey,
    PRIVATE_CLOUD_EXTERNAL_S3_CA: s3Tls.ca,
    PRIVATE_CLOUD_TEST_ALICE_EMAIL: users[0].email, PRIVATE_CLOUD_TEST_ALICE_PASSWORD: users[0].password,
    PRIVATE_CLOUD_TEST_ALICE_OIDC_SUBJECT: identities[0].subject, PRIVATE_CLOUD_TEST_ALICE_OIDC_ISSUER: 'https://localhost:13002',
    PRIVATE_CLOUD_TEST_BOB_EMAIL: users[1].email, PRIVATE_CLOUD_TEST_BOB_PASSWORD: users[1].password,
    PRIVATE_CLOUD_TEST_BOB_OIDC_SUBJECT: identities[1].subject, PRIVATE_CLOUD_TEST_BOB_OIDC_ISSUER: 'https://localhost:13002',
  }
  const result = spawnSync(process.execPath, [join(root, 'scripts/release/verify-private-cloud-clean-compose.mjs'),
    '--fresh-candidate', '--candidate-archive', required('--candidate-archive'),
    '--executor', required('--executor'), '--tag', required('--tag'), '--revision', required('--revision'),
    '--output', required('--output')], { cwd: root, env: acceptanceEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0) throw new Error('Signed candidate fresh acceptance failed: ' + (result.stderr || result.stdout))
  process.stdout.write(result.stdout)
} finally {
  for (const [project, file] of [[identityProject, identityFile], [postgresProject, pgFile], [s3Project, s3File]]) {
    try { run('docker', ['compose', '--project-name', project, '-f', file, 'down', '-v', '--remove-orphans'], env) } catch {}
  }
  if (sharedNetworkCreated) {
    try { run('docker', ['network', 'rm', sharedNetwork], env) } catch {}
  }
  rmSync(scratch, { recursive: true, force: true })
}

function verifyRegistryImage(image) {
  const output = run('docker', ['buildx', 'imagetools', 'inspect', image]).stdout
  if (!output.includes('Digest:    ' + image.split('@')[1])) throw new Error('Official authority image digest not verified: ' + image)
}
function renderIdentityCaddyfile(caddyfile) {
  const tlsSite = caddyfile.replace(':8080 {', ':8443 {\n  tls /run/tls/leaf.pem /run/tls/leaf-key.pem')
    .replaceAll('header_up X-Forwarded-Proto http', 'header_up X-Forwarded-Proto https')
    .replaceAll('{$KALA_IDENTITY_SCHEME:http}', 'https')
  if (tlsSite === caddyfile || !tlsSite.includes('header_up X-Forwarded-Proto https')) throw new Error('Independent TLS OIDC proxy could not be rendered')
  return caddyfile + '\n' + tlsSite
}
function dockerConfigDirectory(environment) {
  if (environment.DOCKER_CONFIG) return environment.DOCKER_CONFIG
  if (!environment.HOME) throw new Error('HOME or DOCKER_CONFIG is required for Docker registry authentication')
  return join(environment.HOME, '.docker')
}

function proxyCertificateDir(parent, authority) {
  const directory = join(parent, 'proxy-tls')
  mkdirSync(directory, { mode: 0o700 })
  cpSync(authority.leaf, join(directory, 'leaf.pem'))
  cpSync(authority.leafKey, join(directory, 'leaf-key.pem'))
  chmodSync(join(directory, 'leaf-key.pem'), 0o600)
  return directory
}
export function renderIdentityOverlay(overlay, bridge, tlsDirectory = '/runlab-tls') {
  if (!/^172\.(?:1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}$/u.test(bridge) && bridge !== '192.0.2.1') throw new Error('Identity bridge gateway must be an isolated private address or documentation fixture')
  if (!tlsDirectory.startsWith('/') || /[\r\n]/u.test(tlsDirectory)) throw new Error('OIDC TLS directory must be absolute')
  const withoutRuntime = overlay.replace(/\n  runtime-ingress:[\s\S]*?(?=\nnetworks:\n)/u, '\n')
  let independent = withoutRuntime.replace('      - 127.0.0.1:${KALA_IDENTITY_PORT:-13002}:8080',
    `      - 127.0.0.1:13003:8080\n      - 127.0.0.1:13002:8443\n      - ${bridge}:13002:8443`)
  independent = independent.replace('  identity-proxy:\n', `  identity-proxy:\n    user: "${process.getuid()}:${process.getgid()}"\n`)
  independent = independent.replace('      - ./identity-local.Caddyfile:/etc/caddy/Caddyfile:ro',
    `      - ./identity-local.Caddyfile:/etc/caddy/Caddyfile:ro\n      - ${tlsDirectory}:/run/tls:ro`)
    .replaceAll('http://localhost:${KALA_IDENTITY_PORT:-13002}', 'https://localhost:${KALA_IDENTITY_PORT:-13002}')
    .replace('ZITADEL_EXTERNALSECURE: "false"', 'ZITADEL_EXTERNALSECURE: "true"')
    .replace('X-Forwarded-Proto:http', 'X-Forwarded-Proto:https')
  if (withoutRuntime === overlay || independent === withoutRuntime || independent.includes('\n  runtime-ingress:') || !independent.includes(`${tlsDirectory}:/run/tls:ro`)) throw new Error('Signed OIDC overlay could not be separated from application services')
  return independent
}
function required(flag) {
  const index = process.argv.indexOf(flag)
  if (index < 0 || !process.argv[index + 1]) throw new Error('missing ' + flag)
  return process.argv[index + 1]
}
function privateFile(path, value) { writeFileSync(path, value, { mode: 0o600, flag: 'wx' }) }
function privateReplace(path, value) { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600) }
async function waitForS3(client, bucket, CreateBucketCommand) {
  const deadline = Date.now() + 120_000
  let last
  while (Date.now() < deadline) {
    try { await client.send(new CreateBucketCommand({ Bucket: bucket })); return } catch (error) { last = error }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
  }
  throw new Error('Independent TLS-verified S3 endpoint did not create an isolated bucket: '
    + `${String(last)}; httpStatus=${last?.$metadata?.httpStatusCode ?? 'none'}; cause=${last?.cause?.code ?? 'none'}`)
}
async function expectDenied(operation) {
  try { await operation() } catch (error) {
    if (error?.$metadata?.httpStatusCode === 403 || ['AccessDenied', 'UnauthorizedAccess'].includes(error?.name)) return
    throw error
  }
  throw new Error('Independent S3 authority accepted a disallowed scoped-credential operation')
}
async function expectPreconditionFailed(operation) {
  try { await operation() } catch (error) {
    if (error?.$metadata?.httpStatusCode === 412) return
    throw error
  }
  throw new Error('Independent S3 authority ignored conditional reserved-object writes')
}
function run(command, args, environment = process.env, input) {
  const result = spawnSync(command, args, { cwd: root, env: environment, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(input ? `${command} failed while applying private PostgreSQL initialization` : `${command} failed: ${result.stderr || result.stdout}`)
  return result
}
function authorityContainerStates(compose, env) {
  return run('docker', [...compose, 'ps', '-a', '--format', 'json'], env).stdout.trim().split('\n')
    .filter(Boolean).map((line) => {
      const { Service, State, Health, ExitCode, Publishers } = JSON.parse(line)
      return { service: Service, state: State, health: Health, exitCode: ExitCode,
        ports: Publishers?.map(({ PublishedPort, TargetPort }) => `${PublishedPort}:${TargetPort}`) }
    })
}
async function waitFor(url, ca, timeout) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try { await verifyHttps(url, ca); return } catch (error) { lastError = error }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
  }
  const reason = lastError instanceof AggregateError
    ? lastError.errors.map((error) => error?.code ?? error?.name ?? 'unknown').join(',')
    : lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error('Independent OIDC endpoint was not ready: ' + reason)
}
