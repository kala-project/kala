#!/usr/bin/env node
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { createServer, isIP } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { getCACertificates } from 'node:tls'
import { bootstrapPrivateCloudIdentity } from './bootstrap-private-cloud-identity.mjs'

const argv = process.argv.slice(2); if (argv[0] === '--') argv.shift()
const command = argv[0]
const operatorRoot = bounded(process.env.KALA_PRIVATE_CLOUD_OPERATOR_ROOT ?? '/var/lib/kala-private-cloud', 'operator root')
const receiptsRoot = join(operatorRoot, 'receipts')
const releasesRoot = join(operatorRoot, 'releases')
const installationPath = join(operatorRoot, 'installation.json')
const activePath = join(operatorRoot, 'active.json')
const predecessorPath = join(operatorRoot, 'predecessor.json')
const transitions = new Map([
  ['planned', new Set(['verified', 'failed'])], ['verified', new Set(['pulled', 'backup_completed', 'stopped', 'failed'])],
  ['pulled', new Set(['backup_completed', 'services_updated', 'failed'])], ['backup_completed', new Set(['services_updated', 'failed'])],
  ['stopped', new Set(['backup_completed', 'restored', 'removed', 'failed'])], ['restored', new Set(['services_updated', 'failed'])],
  ['services_updated', new Set(['ready', 'failed'])], ['ready', new Set(['completed', 'failed'])],
  ['removed', new Set(['completed', 'failed'])], ['completed', new Set()], ['failed', new Set()],
])
const secretNames = ['control_postgres_password', 'session_secret', 'ingress_secret', 'oidc_client_id', 'oidc_client_secret', 'llm_api_key']
const postgresS3SecretNames = ['control_postgres_migration_owner_url', 'control_postgres_writer_url', 'runtime_postgres_owner_url', 'runtime_postgres_writer_url', 'runtime_postgres_reader_url', 'runtime_state_master_key', 'runtime_s3_access_key_id', 'runtime_s3_secret_access_key', 'installation_claim_s3_access_key_id', 'installation_claim_s3_secret_access_key']
const tlsNames = ['internal_ca_key.pem', 'internal_ca.pem', 'runtime_host_key.pem', 'runtime_host.pem', 'ingress_client_key.pem', 'ingress_client.pem', 'runtime_health_key.pem', 'runtime_health.pem']
const oidcCaName = 'oidc-ca.pem'
const configOriginName = 'storage-origin.json'
const installationIdName = 'installation-id'

main().catch((error) => { process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = 1 })

async function main() {
 if (!command || ['help', '-h', '--help'].includes(command)) { help(); return }
 if (!['setup', 'init-config', 'preflight', 'doctor', 'provision-organization', 'create-owner-bootstrap', 'owner-bootstrap-status', 'confirm-owner-bootstrap', 'install', 'status', 'upgrade', 'upgrade-dashboard', 'rollback', 'backup', 'restore', 'uninstall'].includes(command)) fail(`unknown command ${command}`)
 let operationLock
 try {
  if (!['init-config', 'preflight', 'doctor', 'status'].includes(command)) operationLock = acquireOperationLock()
  if (command === 'setup') await setup()
  else if (command === 'init-config') await initConfig()
  else if (command === 'preflight') await preflight()
  else if (command === 'doctor') await doctor()
  else if (command === 'provision-organization') provisionOrganization()
  else if (command === 'create-owner-bootstrap') createOwnerBootstrap()
  else if (command === 'owner-bootstrap-status') ownerBootstrapStatus()
  else if (command === 'confirm-owner-bootstrap') confirmOwnerBootstrap()
  else if (command === 'install') await install()
  else if (command === 'status') status()
  else if (command === 'upgrade') upgrade(false)
  else if (command === 'upgrade-dashboard') upgrade(true)
  else if (command === 'rollback') rollback()
  else if (command === 'backup') await backup()
  else if (command === 'restore') await restore()
  else if (command === 'uninstall') uninstall()
 } catch (error) { process.stderr.write(`${redact(error instanceof Error ? error.message : String(error))}\n`); process.exitCode = 1 }
 finally { releaseOperationLock(operationLock) }
}

function help() { process.stdout.write(`Kala Private Cloud operator

Usage:
  kala-private-cloud setup --bundle DIR --config-dir EXISTING_DIR --provider-catalog FILE --llm-api-key-file FILE [--identity bundled|external] [--app-port PORT --identity-port PORT] [--oidc-issuer URL --oidc-discovery-origin URL --oidc-client-id-file FILE --oidc-client-secret-file FILE]
  kala-private-cloud init-config --bundle DIR --config-dir EMPTY_DIR [--profile local|cloudflare] [--identity external] [--storage postgres-s3] --acknowledge-evaluation --acknowledge-external-backup [--app-port PORT]
  kala-private-cloud preflight --bundle DIR --config-dir DIR
  kala-private-cloud doctor --bundle DIR --config-dir DIR [--allow-private-origin HTTPS_ORIGIN ...]
  kala-private-cloud provision-organization --owner-issuer URL --owner-subject SUBJECT --owner-email EMAIL --organization-name NAME --contract-reference REF --ends-at ISO_DATE --operation-id ID
  kala-private-cloud create-owner-bootstrap --owner-issuer URL --owner-email EMAIL --organization-name NAME --contract-reference REF --ends-at ISO_DATE --operation-id ID [--ttl-minutes 15]
  kala-private-cloud owner-bootstrap-status --authorization-id ID
  kala-private-cloud confirm-owner-bootstrap --authorization-id ID --confirmation-code CODE
  kala-private-cloud install --bundle DIR --config-dir DIR
  kala-private-cloud status
  kala-private-cloud upgrade --bundle DIR
  kala-private-cloud upgrade-dashboard --bundle DIR
  kala-private-cloud rollback
  kala-private-cloud backup --output EMPTY_PERSISTENT_DIR
  kala-private-cloud restore --backup DIR --confirm RESTORE:<backup-id>
  kala-private-cloud uninstall --confirm UNINSTALL:<installation-id>

The release bundle is immutable and digest pinned. Uninstall preserves Docker
volumes, configuration, secrets, copied releases, receipts, and backups.

Fresh installations require external PostgreSQL/S3 and cannot use setup:
provision external authorities, then use init-config, preflight, and install.
New local-volume/NFS configurations are not supported. setup can only complete
an already prepared PG/S3 configuration; existing legacy installs retain their
recorded mode for maintenance, never for a new install or silent migration. For
--identity external, configure your HTTPS IdP/client and replace its placeholders
before preflight. Bundled identity is available only with --profile local.
The optional owner bootstrap derives \`sub\` only from a
validated OIDC callback and still requires explicit local operator confirmation.
For the compatible manual path, obtain the exact \`sub\`; email is not a substitute.
postgres-s3 is a fresh-project evaluation only. It requires external OIDC,
operator-managed PostgreSQL/S3, both acknowledgement flags, and has no Operator
upgrade, rollback, backup, restore, or uninstall workflow. Its backup acknowledgement
is an assertion of an external plan, not restore evidence.
`) }

async function setup() {
  const configDir = bounded(required('--config-dir'), 'configuration directory')
  const identity = option('--identity') ?? 'bundled'
  if (!['bundled', 'external'].includes(identity)) throw new Error('--identity must be bundled or external')
  if (existsSync(installationPath)) throw new Error('Private Cloud is already installed')
  const catalogInput = bounded(required('--provider-catalog'), 'provider catalog')
  const catalog = lstatSync(catalogInput)
  if (!catalog.isFile() || catalog.isSymbolicLink()) throw new Error('--provider-catalog must be a regular file')
  const llmKeyFile = required('--llm-api-key-file')
  validateSetupSecret(llmKeyFile)
  const external = identity === 'external' ? {
    issuer: validHttpsOrigin(required('--oidc-issuer'), '--oidc-issuer'),
    discovery: validHttpsOrigin(required('--oidc-discovery-origin'), '--oidc-discovery-origin'),
    clientId: required('--oidc-client-id-file'), clientSecret: required('--oidc-client-secret-file'),
  } : null
  if (external) { validateSetupSecret(external.clientId); validateSetupSecret(external.clientSecret) }
  const fresh = !existsSync(join(configDir, 'deployment.env'))
  if (fresh) throw new Error('fresh Private Cloud requires external PostgreSQL/S3; setup cannot provision these authorities. Use init-config --storage postgres-s3 --identity external with evaluation/backup acknowledgements, provision external credentials, then preflight/install. New local-volume/NFS installations are disabled; existing installations retain their recorded mode')
  if (deploymentEnv(configDir).KALA_STORAGE !== 'postgres-s3') throw new Error('setup cannot create a new legacy volume/NFS installation from an old configuration; preserve existing installed projects and use external PostgreSQL/S3 for new installations')
  if (deploymentEnv(configDir).KALA_IDENTITY_MODE !== identity) throw new Error('existing configuration uses a different identity mode; do not regenerate identity data')
  if (!fresh && option('--app-port') && validPort(option('--app-port'), '--app-port') !== localPorts(deploymentEnv(configDir)).app) throw new Error('cannot change app port on an existing installation configuration; OIDC redirect and identities must be migrated explicitly')
  if (!fresh && option('--identity-port') && validPort(option('--identity-port'), '--identity-port') !== localPorts(deploymentEnv(configDir)).identity) throw new Error('cannot change identity port on an existing configuration; OIDC issuer migration is required')
  if (!fresh && option('--nfs-port') && validPort(option('--nfs-port'), '--nfs-port') !== localPorts(deploymentEnv(configDir)).nfs) throw new Error('cannot change NFS port on an existing installation configuration without reviewing the mounted storage')
  if (!fresh && option('--storage') && option('--storage') !== deploymentEnv(configDir).KALA_STORAGE) throw new Error('cannot change storage mode on an existing configuration without migrating the data')
  // A retry only fills placeholders; established credentials and IdP values are
  // never overwritten after a partially completed identity enrollment.
  const existingCatalog = requiredJson(join(configDir, 'runtime-provider-catalog.json'))
  if (fresh || existingCatalog.providers?.some((provider) => ['192.0.2.5', 'example.com'].includes(new URL(provider.baseUrl).hostname))) {
    copyFileSync(catalogInput, join(configDir, 'runtime-provider-catalog.json'))
    chmodSync(join(configDir, 'runtime-provider-catalog.json'), 0o600)
  }
  if (placeholder(readFileSync(join(configDir, 'secrets', 'llm_api_key'), 'utf8').trim())) copySetupSecret(llmKeyFile, join(configDir, 'secrets', 'llm_api_key'))
  if (external) {
    const environment = deploymentEnv(configDir)
    if (!placeholder(environment.OIDC_ISSUER ?? '') && environment.OIDC_ISSUER !== external.issuer) throw new Error('configured external OIDC issuer differs from the requested issuer; identity migration requires explicit review')
    if (!placeholder(environment.OIDC_DISCOVERY_ORIGIN ?? '') && environment.OIDC_DISCOVERY_ORIGIN !== external.discovery) throw new Error('configured external OIDC discovery origin differs from the requested origin')
    if (placeholder(environment.OIDC_ISSUER ?? '') || placeholder(environment.OIDC_DISCOVERY_ORIGIN ?? '')) writeFileSync(join(configDir, 'deployment.env'), `\nOIDC_ISSUER=${external.issuer}\nOIDC_DISCOVERY_ORIGIN=${external.discovery}\n`, { flag: 'a' })
    for (const [flag, name] of [[external.clientId, 'oidc_client_id'], [external.clientSecret, 'oidc_client_secret']]) {
      const current = readFileSync(join(configDir, 'secrets', name), 'utf8').trim()
      if (placeholder(current)) copySetupSecret(flag, join(configDir, 'secrets', name))
      else if (current !== readFileSync(flag, 'utf8').trim()) throw new Error(`configured ${name} differs from the requested credential; review external OIDC client registration`)
    }
  }
  await preflight()
  await install()
  const environment = deploymentEnv(configDir)
  const ports = localPorts(environment)
  output({ ok: true, kalaUrl: `http://localhost:${ports.app}`, ...(identity === 'bundled' ? { identityUrl: `http://localhost:${ports.identity}` } : {}), storage: environment.KALA_STORAGE, ...(environment.KALA_STORAGE === 'nfs' ? { nfsPort: ports.nfs } : {}), browserLoginVerified: false, firstOwnerProvisioned: false, next: 'On the installation machine, confirm a real browser login and complete the trusted first-owner bootstrap. Do not publish the loopback issuer remotely.' })
}
function validateSetupSecret(input) {
  const source = bounded(input, 'credential file')
  const info = lstatSync(source)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('credential input must be a private regular file (0600)')
  if (!readFileSync(source, 'utf8').trim()) throw new Error('credential input must not be empty')
  return source
}
function copySetupSecret(input, destination) {
  copyFileSync(validateSetupSecret(input), destination)
  chmodSync(destination, 0o600)
}
function initialIdentityPassword() {
  // A base64url password has a substantial chance of containing no symbol.
  const chars = [...randomBytes(36).toString('base64url'), 'A', 'a', '0', '!']
  for (let i = chars.length - 1; i > 0; i--) { const j = randomBytes(4).readUInt32BE() % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]] }
  return chars.join('')
}
async function initConfig() {
  const bundle = bounded(required('--bundle'), 'bundle directory')
  const destination = bounded(required('--config-dir'), 'configuration directory')
  const profile = option('--profile') ?? 'local'
  const storage = option('--storage') ?? 'postgres-s3'
  const identity = option('--identity') ?? 'external'
  if (storage !== 'postgres-s3') throw new Error('new Private Cloud configurations require --storage postgres-s3; local-volume/NFS are legacy authorities, not a cloud-native installation')
  if (storage === 'postgres-s3') {
    if (identity !== 'external') throw new Error('postgres-s3 evaluation requires --identity external; bundled identity uses a local database')
    if (!argv.includes('--acknowledge-evaluation')) throw new Error('postgres-s3 requires --acknowledge-evaluation because it is fresh-project evaluation only, not production or an in-place migration')
    if (!argv.includes('--acknowledge-external-backup')) throw new Error('postgres-s3 requires --acknowledge-external-backup after defining an external PostgreSQL/S3 backup plan; acknowledgement is not restore proof')
  }
  if (option('--nfs-port')) throw new Error('--nfs-port is only for existing legacy NFS installations')
  if (!['local', 'cloudflare'].includes(profile)) throw new Error('--profile must be local or cloudflare')
  if (!['bundled', 'external'].includes(identity)) throw new Error('--identity must be bundled or external')
  if (identity === 'bundled' && profile !== 'local') throw new Error('bundled identity requires the local loopback profile')
  if (identity !== 'bundled' && option('--identity-port')) throw new Error('--identity-port applies only to bundled identity')
  const requestedApp = option('--app-port') ? validPort(option('--app-port'), '--app-port') : 13001
  const requestedIdentity = option('--identity-port') ? validPort(option('--identity-port'), '--identity-port') : 13002
  if (identity === 'bundled' && Boolean(option('--app-port')) !== Boolean(option('--identity-port'))) throw new Error('specify both --app-port and --identity-port, or let the bundled installer select a free loopback pair')
  const ports = identity === 'bundled' && !option('--app-port') ? await chooseLocalPorts() : { app: requestedApp, identity: requestedIdentity }
  if (identity === 'bundled' && ports.app === ports.identity) throw new Error('Kala and identity must use different loopback ports')
  if (!await loopbackPortFree(ports.app)) throw new Error(`Kala loopback port ${ports.app} is already in use; leave the existing service running and choose --app-port before registering an external OIDC callback`)
  if (identity === 'bundled' && !await loopbackPortFree(ports.identity)) throw new Error(`identity loopback port ${ports.identity} is already in use; choose --app-port and --identity-port together`)
  ensureEmpty(destination)
  const staging = `${destination}.staging-${process.pid}-${randomUUID()}`
  try {
    mkdirSync(join(staging, 'secrets'), { recursive: true, mode: 0o700 })
    copyRequired(join(bundle, `${profile}.env.example`), join(staging, 'deployment.env'))
    // The published beta templates are retained for legacy projects, not used as a new storage authority.
    const template = readFileSync(join(staging, 'deployment.env'), 'utf8').replace(/^(?:KALA_STORAGE|COMPOSE_PROJECT_NAME)=.*\n/gmu, '')
    writeFileSync(join(staging, 'deployment.env'), `${template}\nKALA_STORAGE=postgres-s3\nKALA_PUBLIC_LISTEN=127.0.0.1:${ports.app}\n${profile === 'local' ? `KALA_PUBLIC_URLS=http://localhost:${ports.app}\n` : ''}COMPOSE_PROJECT_NAME=kala-private-cloud-pg-s3-eval-${randomUUID().slice(0, 8)}\nKALA_PG_S3_EVALUATION_ACK=1\nKALA_PG_S3_EXTERNAL_BACKUP_ACK=1\n`)
    const installationId = randomUUID()
    writeFileSync(join(staging, configOriginName), `${JSON.stringify({ schemaVersion: 1, storageMode: storage, installationId })}\n`, { mode: 0o600, flag: 'wx' })
    writeFileSync(join(staging, installationIdName), `${installationId}\n`, { mode: 0o600, flag: 'wx' })
    if (identity === 'bundled') {
      writeFileSync(join(staging, 'deployment.env'), `\nKALA_IDENTITY_MODE=bundled\nKALA_IDENTITY_PORT=${ports.identity}\nOIDC_ISSUER=http://localhost:${ports.identity}\nOIDC_DISCOVERY_ORIGIN=http://identity-proxy:8080\n`, { flag: 'a' })
      mkdirSync(join(staging, 'identity-secrets'), { mode: 0o700 })
      for (const [name, value] of Object.entries({ postgres_password: randomBytes(32).toString('base64url'), zitadel_masterkey: randomBytes(24).toString('base64url'), initial_human_password: initialIdentityPassword() })) writeFileSync(join(staging, 'identity-secrets', name), value, { mode: 0o600, flag: 'wx' })
    } else writeFileSync(join(staging, 'deployment.env'), '\nKALA_IDENTITY_MODE=external\n', { flag: 'a' })
    copyRequired(join(bundle, 'runtime-provider-catalog.example.json'), join(staging, 'runtime-provider-catalog.json'))
    chmodSync(join(staging, 'deployment.env'), 0o600)
    chmodSync(join(staging, 'runtime-provider-catalog.json'), 0o600)
    const generated = {
      session_secret: randomBytes(48).toString('base64url'),
      ingress_secret: randomBytes(48).toString('base64url'),
      oidc_client_id: 'REPLACE_WITH_EXTERNAL_OIDC_CLIENT_ID',
      oidc_client_secret: 'REPLACE_WITH_EXTERNAL_OIDC_CLIENT_SECRET',
      llm_api_key: 'REPLACE_WITH_PROVIDER_API_KEY',
    }
    for (const [name, value] of Object.entries(generated)) writeFileSync(join(staging, 'secrets', name), value, { mode: 0o600, flag: 'wx' })
    generateTls(join(staging, 'secrets'))
    for (const name of tlsNames) chmodSync(join(staging, 'secrets', name), 0o600)
    rmSync(destination, { recursive: true })
    renameSync(staging, destination)
    fsyncDirectory(dirname(destination))
    output({ ok: true, configDir: destination, profile, identity, storage, ...(profile === 'local' ? { kalaUrl: `http://localhost:${ports.app}` } : {}), ...(identity === 'bundled' ? { identityUrl: `http://localhost:${ports.identity}` } : {}), next: storage === 'postgres-s3' ? ['configure external IdP/OIDC client redirect URLs and provider key', 'create the required external PostgreSQL/S3 credential files and a preserved 32-byte raw runtime_state_master_key with mode 0600', 'set non-secret database roles and S3 endpoint/region/bucket values in deployment.env', 'run preflight; external service readiness and recoverability remain operator responsibilities'] : identity === 'bundled' ? ['configure model provider and replace LLM key placeholder', 'run preflight', 'run install; securely retrieve and change the initial identity admin password'] : ['configure external IdP/OIDC client redirect URLs', 'replace OIDC and LLM placeholder secret files', 'run preflight'] })
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

async function preflight() {
  const bundle = bounded(required('--bundle'), 'bundle directory')
  const configDir = bounded(required('--config-dir'), 'configuration directory')
  const evaluationChecks = await deploymentPreflight(bundle, configDir)
  output({ ok: true, bundle: { version: requiredJson(join(bundle, 'manifest.json')).version }, configDir, checks: ['bundle-integrity', 'configuration', 'secret-permissions', deploymentEnv(configDir).KALA_IDENTITY_MODE === 'bundled' ? 'bundled-oidc-values' : 'external-oidc-values', 'oidc-private-ca', 'provider-key', 'docker-daemon', 'docker-compose', 'compose-config', 'loopback-ports', ...evaluationChecks] })
}

async function deploymentPreflight(bundle, configDir) {
  verifyBundle(bundle)
  validateConfig(configDir)
  const installation = optionalJson(installationPath)
  if (installation?.configDir === configDir) assertInstallationConfiguration(installation, configDir)
  if (!installation || installation.configDir !== configDir) await assertPortsAvailable(configDir)
  captureSync('docker', ['--version'])
  const composeVersion = captureSync('docker', ['compose', 'version', '--short'])
  captureSync('docker', ['info', '--format', '{{json .ServerVersion}}'])
  const release = { dir: bundle, lock: requiredJson(join(bundle, 'image-lock.json')) }
  const postgresS3 = deploymentEnv(configDir).KALA_STORAGE === 'postgres-s3'
  if (postgresS3 && !['compose.postgres-s3-base.yaml', 'compose.storage-postgres-s3.yaml'].every((name) => requiredJson(join(bundle, 'manifest.json')).files?.[name])) throw new Error('PostgreSQL/S3 independent root or evaluation overlay is missing from the bundle')
  if (!postgresS3) {
    const invocation = composeInvocation(release, configDir, ['config', '--quiet'])
    captureSync(invocation.command, invocation.args, invocation.cwd, invocation.env)
    return []
  }
  requireComposeOverrideVersion(composeVersion)
  const invocation = composeInvocation(release, configDir, ['config', '--format', 'json'])
  const rendered = JSON.parse(captureSync(invocation.command, invocation.args, invocation.cwd, invocation.env))
  validatePostgresS3RenderedConfig(rendered, configDir)
  if (!installation || installation.configDir !== configDir) {
    const project = composeInvocation(release, configDir, ['ps', '--all', '--quiet'])
    if (captureSync(project.command, project.args, project.cwd, project.env).trim()) throw new Error('postgres-s3 requires a fresh Compose project with no existing containers; choose a new COMPOSE_PROJECT_NAME and do not stop or migrate the old project')
    for (const resource of ['volume', 'network']) {
      const existing = captureSync('docker', [resource, 'ls', '--filter', `label=com.docker.compose.project=${projectName(configDir)}`, '--format', '{{.Name}}']).trim()
      if (existing) throw new Error(`postgres-s3 requires a fresh Compose project; existing ${resource} resources belong to this project. Do not reuse old volumes or networks`)
    }
  }
  return ['compose-override-version', 'postgres-s3-rendered-topology', 'fresh-evaluation-project']
}
function requireComposeOverrideVersion(value) {
  const match = String(value).match(/(?:^|\s)v?(\d+)\.(\d+)(?:\.\d+)?/u)
  if (!match || Number(match[1]) < 2 || Number(match[1]) === 2 && Number(match[2]) < 24) throw new Error('postgres-s3 requires Docker Compose 2.24 or newer for !override; upgrade Compose instead of falling back to legacy storage')
}
function validatePostgresS3RenderedConfig(config, configDir) {
  const services = config.services ?? {}
  for (const name of ['init-volumes', 'control-postgres', 'nfs-server']) if (services[name]) throw new Error(`postgres-s3 rendered topology must not contain legacy ${name}`)
  for (const name of ['tenant-data', 'control-data', 'control-postgres-data', 'nfs-session-data']) if (config.volumes?.[name]) throw new Error(`postgres-s3 rendered topology must not declare legacy ${name}`)
  for (const name of ['control', 'nfs']) if (config.networks?.[name]) throw new Error(`postgres-s3 rendered topology must not declare legacy ${name} network`)
  const secretProjections = new Set(['host-secrets', 'gateway-secrets', 'runtime-storage-secrets', 'gateway-storage-secrets'])
  for (const [name, volume] of Object.entries(config.volumes ?? {})) if (!secretProjections.has(name) || volume.driver_opts || volume.driver && volume.driver !== 'local') throw new Error(`postgres-s3 cannot declare an additional or remotely backed volume: ${name}`)
  for (const [name, service] of Object.entries(services)) for (const mount of service.volumes ?? []) if (mount.type === 'volume' && !secretProjections.has(mount.source)) throw new Error(`postgres-s3 ${name} mounts a non-projection volume`)
  const volumeTarget = (volume) => typeof volume === 'string' ? volume.split(':')[1] : volume?.target
  const secretSource = (secret) => typeof secret === 'string' ? secret : secret?.source
  const runtime = services['runtime-host']; const ingress = services['runtime-ingress']; const controlInit = services['control-plane-init']; const runtimeInit = services['runtime-schema-init']; const storageInit = services['init-storage-secrets']; const claim = services['fresh-storage-claim']
  if (!runtime || !ingress || !controlInit || !runtimeInit || !storageInit || !claim) throw new Error('postgres-s3 rendered topology is missing required external storage/claim services')
  if ((runtime.volumes ?? []).some((volume) => volumeTarget(volume) === '/var/lib/kala' || secretSource(volume) === 'tenant-data')) throw new Error('postgres-s3 runtime-host must not mount tenant-data or any persistent /var/lib/kala volume')
  const scratch = (runtime.tmpfs ?? []).some((mount) => (typeof mount === 'string' ? mount.split(':')[0] : mount?.target) === '/var/lib/kala')
  if (!scratch) throw new Error('postgres-s3 runtime-host must use bounded disposable /var/lib/kala tmpfs')
  if ((ingress.volumes ?? []).some((volume) => volumeTarget(volume) === '/var/lib/kala-control' || secretSource(volume) === 'control-data')) throw new Error('postgres-s3 runtime-ingress must not mount control-data')
  if (ingress.environment?.KALA_INGRESS_LOGIN_STATE_STORE_KIND !== 'postgres') throw new Error('postgres-s3 OIDC login state must use external control PostgreSQL')
  if (controlInit.environment?.KALA_INGRESS_REQUIRE_EXISTING_DATABASE !== '1' || Object.keys(controlInit.depends_on ?? {}).join(',') !== 'fresh-storage-claim' || Object.keys(runtimeInit.depends_on ?? {}).join(',') !== 'fresh-storage-claim') throw new Error('postgres-s3 migrations must depend solely on the completed fresh external-storage claim')
  for (const job of [controlInit, runtimeInit]) if (job.depends_on['fresh-storage-claim']?.condition !== 'service_completed_successfully') throw new Error('postgres-s3 schema jobs must wait for a successful fresh storage claim')
  if ((claim.volumes ?? []).length || (claim.configs ?? []).map(secretSource).join(',') !== 'installation_id' || config.configs?.installation_id?.file !== join(configDir, installationIdName)) throw new Error('postgres-s3 claim must use the Operator installation UUID without a persistent local receipt')
  const claimSecrets = (claim.secrets ?? []).map(secretSource).sort()
  if (JSON.stringify(claimSecrets) !== JSON.stringify(['control_postgres_migration_owner_url', 'runtime_postgres_owner_url', 'runtime_state_master_key', 'installation_claim_s3_access_key_id', 'installation_claim_s3_secret_access_key'].sort()) || claim.environment?.KALA_FRESH_CLAIM_STATE_MASTER_KEY_FILE !== '/run/secrets/runtime_state_master_key' || claim.environment?.KALA_FRESH_CLAIM_S3_ACCESS_KEY_ID_FILE !== '/run/secrets/installation_claim_s3_access_key_id' || claim.environment?.KALA_FRESH_CLAIM_S3_SECRET_ACCESS_KEY_FILE !== '/run/secrets/installation_claim_s3_secret_access_key') throw new Error('postgres-s3 claim must receive only the two owner URLs and its separate scoped S3 credentials')
  const controlSecrets = (controlInit.secrets ?? []).map(secretSource); const runtimeInitSecrets = (runtimeInit.secrets ?? []).map(secretSource); const storageSecrets = (storageInit.secrets ?? []).map(secretSource)
  if (JSON.stringify(controlSecrets) !== JSON.stringify(['control_postgres_migration_owner_url']) || JSON.stringify(runtimeInitSecrets) !== JSON.stringify(['runtime_postgres_owner_url'])) throw new Error('postgres-s3 migration owners must be isolated to their one-shot schema jobs')
  if (storageSecrets.includes('runtime_postgres_owner_url') || storageSecrets.some((name) => name.startsWith('installation_claim_s3_')) || !['runtime_postgres_writer_url', 'runtime_postgres_reader_url', 'runtime_s3_access_key_id', 'runtime_s3_secret_access_key', 'runtime_state_master_key'].every((name) => storageSecrets.includes(name))) throw new Error('postgres-s3 workload secret projection must exclude owner credentials and include restricted Runtime/S3 credentials')
  if (runtime.environment?.KALA_RUNTIME_EXPERIMENTAL_POSTGRES_CONNECTION_STRING_FILE !== '/run/kala-storage/runtime_postgres_writer_url' || ingress.environment?.KALA_INGRESS_EXPERIMENTAL_POSTGRES_READER_CONNECTION_STRING_FILE !== '/run/kala-storage/runtime_postgres_reader_url') throw new Error('postgres-s3 Runtime writer and Gateway reader credentials are not isolated in the rendered topology')
  for (const [name, service, flag] of [['runtime-host', runtime, 'KALA_RUNTIME_REQUIRE_INSTALLATION_CLAIM'], ['runtime-ingress', ingress, 'KALA_INGRESS_REQUIRE_INSTALLATION_CLAIM']]) {
    if (service.environment?.[flag] !== '1' || service.environment?.KALA_INSTALLATION_ID_FILE !== '/run/kala-installation/installation-id' || !(service.configs ?? []).some((entry) => secretSource(entry) === 'installation_id' && entry.target === '/run/kala-installation/installation-id')) throw new Error(`postgres-s3 ${name} must verify the Operator installation UUID against its external authorities at startup`)
  }
}

async function doctor() {
  let bundle
  let configDir
  try {
    bundle = bounded(required('--bundle'), 'bundle directory')
    configDir = bounded(required('--config-dir'), 'configuration directory')
    verifyBundle(bundle)
    validateConfig(configDir)
  } catch (error) {
    output({ schemaVersion: 1, ok: false, checks: [{ id: 'doctor-input', status: 'fail', message: doctorMessage(error, configDir), remediation: 'Run preflight and fix the bundle or configuration before retrying doctor.' }] })
    process.exitCode = 1
    return
  }

  const environment = deploymentEnv(configDir)
  const lock = requiredJson(join(bundle, 'image-lock.json'))
  const catalog = requiredJson(join(configDir, 'runtime-provider-catalog.json'))
  const allowedPrivateOrigins = doctorAllowedPrivateOrigins(environment, catalog)
  const checks = []
  for (const name of ['runtime', 'ingress', 'dashboard']) {
    const image = lock.images[name]
    checks.push(await doctorCheck(`registry.${name}`, image, 'Authenticate the target Docker daemon to this registry with package read access, or use a separately verified digest-pinned mirror.', async () => {
      captureSync('docker', ['pull', image])
      return 'The target Docker daemon pulled the immutable digest.'
    }, configDir))
  }

  if (environment.KALA_IDENTITY_MODE === 'bundled') {
    const identityOrigin = `http://localhost:${localPorts(environment).identity}`
    if (existsSync(installationPath) && optionalJson(installationPath)?.configDir === configDir) {
      const identityCheck = await doctorCheck('oidc.discovery', identityOrigin, 'Check the bundled identity proxy and configured localhost issuer, then rerun doctor.', async () => {
        await verifyBundledIdentity(configDir)
        return 'Bundled localhost issuer and signing keys are reachable; a browser login/callback is still required.'
      }, configDir)
      checks.push(identityCheck)
      checks.push({ id: 'oidc.jwks', status: identityCheck.status, target: identityOrigin, message: identityCheck.status === 'pass' ? 'The bundled JWKS has signing keys.' : 'JWKS is not validated because bundled discovery failed.', remediation: identityCheck.remediation })
    } else {
      checks.push({ id: 'oidc.discovery', status: 'manual', target: identityOrigin, message: 'Bundled loopback identity is started during install, not during preflight.', remediation: 'After install, open the local login page and verify a real OIDC callback before adding users.' })
      checks.push({ id: 'oidc.jwks', status: 'manual', target: identityOrigin, message: 'Bundled local identity uses explicit HTTP loopback only.', remediation: 'Verify real local login and callback after install.' })
    }
  } else {
  const issuer = new URL(validHttpsOrigin(environment.OIDC_ISSUER, 'OIDC_ISSUER in deployment.env'))
  const discoveryOrigin = new URL(validHttpsOrigin(environment.OIDC_DISCOVERY_ORIGIN, 'OIDC_DISCOVERY_ORIGIN in deployment.env'))
  const oidcCa = existsSync(join(configDir, oidcCaName)) ? readFileSync(join(configDir, oidcCaName), 'utf8') : undefined
  const publicDiscovery = oidcDiscoveryUrl(issuer)
  const discoveryTarget = rewriteOidcTarget(publicDiscovery, issuer, discoveryOrigin)
  let metadata
  checks.push(await doctorCheck('oidc.discovery', displayUrl(publicDiscovery), 'Correct OIDC_ISSUER/OIDC_DISCOVERY_ORIGIN, DNS, routing, private-origin authorization, or the trusted CA chain; never disable TLS verification.', async () => {
    const discovered = await requestJson(discoveryTarget, { ca: oidcCa, headers: oidcHeaders(publicDiscovery, issuer), privateMode: doctorPrivateMode(discoveryTarget, allowedPrivateOrigins) })
    if (discovered.issuer !== issuer.href.replace(/\/$/u, '')) throw new Error('discovery metadata issuer does not exactly match OIDC_ISSUER')
    if (typeof discovered.jwks_uri !== 'string') throw new Error('discovery metadata does not contain jwks_uri')
    metadata = discovered
    return 'Discovery metadata is reachable over trusted TLS and reports the configured issuer.'
  }, configDir))

  if (!metadata) {
    checks.push({ id: 'oidc.jwks', status: 'manual', target: issuer.origin, message: 'JWKS was not requested because discovery did not pass.', remediation: 'Fix or manually review the OIDC discovery result, then rerun doctor.' })
  } else {
    checks.push(await doctorCheck('oidc.jwks', displayUrl(metadata.jwks_uri), 'Publish a valid HTTPS jwks_uri with at least one key and make it reachable through the configured discovery topology.', async () => {
      const publicJwks = safeHttpsUrl(metadata.jwks_uri, 'OIDC jwks_uri')
      const sameIssuerOrigin = publicJwks.origin === issuer.origin
      const jwksTarget = rewriteOidcTarget(publicJwks, issuer, discoveryOrigin)
      const jwks = await requestJson(jwksTarget, { ca: oidcCa, headers: oidcHeaders(publicJwks, issuer), privateMode: sameIssuerOrigin ? doctorPrivateMode(jwksTarget, allowedPrivateOrigins) : 'deny' })
      if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error('JWKS does not contain any keys')
      return 'JWKS is reachable over trusted TLS and contains at least one key.'
    }, configDir))
  }

  }
  for (const value of environment.KALA_PUBLIC_URLS.split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const url = new URL(value)
    if (url.protocol !== 'https:') checks.push({ id: 'public-origin', status: 'manual', target: url.origin, message: 'This local HTTP origin has no DNS or trusted TLS to verify automatically.', remediation: 'For an external release, configure the real HTTPS origin and rerun doctor; otherwise verify the deliberate loopback setup manually.' })
    else checks.push(await doctorCheck('public-origin', url.origin, 'Fix public DNS, ingress routing, and the complete trusted TLS certificate chain before the release.', async () => {
      await requestHead(url, { privateMode: doctorPrivateMode(url, allowedPrivateOrigins) })
      return 'The public origin completed a trusted TLS connection and returned an HTTP response.'
    }, configDir))
  }

  for (const provider of catalog.providers) {
    const configuredUrl = String(provider.baseUrl)
    const target = displayUrl(configuredUrl)
    let url
    try { url = new URL(configuredUrl) } catch { url = null }
    if (!url || url.protocol !== 'https:') checks.push({ id: `model.${String(provider.id ?? 'unknown')}`, status: 'manual', target, message: 'A trusted TLS connection cannot be proven for this non-HTTPS model base URL.', remediation: 'Use an HTTPS model base URL with a trusted certificate, or document and manually approve the isolated network exception.' })
    else if (url.username || url.password || url.search || url.hash) checks.push({ id: `model.${String(provider.id ?? 'unknown')}`, status: 'fail', target, message: 'The model base URL must not contain credentials, a query, or a fragment.', remediation: 'Move credentials to the protected llm_api_key file and configure a clean HTTPS model base URL.' })
    else checks.push(await doctorCheck(`model.${String(provider.id ?? 'unknown')}`, target, 'Fix the model base URL, network route, DNS, or trusted server certificate; no API credential is used by doctor.', async () => {
      await requestHead(url, { privateMode: doctorPrivateMode(url, allowedPrivateOrigins) })
      return 'The model base URL completed a trusted TLS connection without an authenticated or billable inference request.'
    }, configDir))
  }

  const ok = !checks.some((check) => check.status === 'fail')
  output({ schemaVersion: 1, ok, checks })
  if (!ok) process.exitCode = 1
}

async function doctorCheck(id, target, remediation, action, configDir) {
  try { return { id, status: 'pass', target, message: await action(), remediation: null } }
  catch (error) { return { id, status: error?.doctorStatus === 'manual' ? 'manual' : 'fail', target, message: doctorMessage(error, configDir), remediation } }
}
function oidcDiscoveryUrl(issuer) { const path = `${issuer.pathname.replace(/\/$/u, '')}/.well-known/openid-configuration`.replace(/^\/+/u, '/'); return new URL(path, issuer.origin) }
function rewriteOidcTarget(url, issuer, discoveryOrigin) { return url.origin === issuer.origin ? new URL(`${url.pathname}${url.search}`, discoveryOrigin) : url }
function oidcHeaders(url, issuer) { return url.origin === issuer.origin ? { 'x-zitadel-instance-host': issuer.host, 'x-zitadel-public-host': issuer.host } : {} }
function safeHttpsUrl(value, label) {
  let url
  try { url = new URL(value) } catch { throw new Error(`${label} is not a valid URL`) }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${label} must use HTTPS without credentials`)
  return url
}
function displayUrl(value) {
  try { const url = new URL(value); return url.username || url.password ? '<credential-bearing URL>' : url.origin } catch { return '<invalid URL>' }
}
function doctorAllowedPrivateOrigins(environment, catalog) {
  const configured = new Set([new URL(environment.OIDC_DISCOVERY_ORIGIN).origin])
  for (const value of environment.KALA_PUBLIC_URLS.split(',').map((entry) => entry.trim()).filter(Boolean)) configured.add(new URL(value).origin)
  for (const provider of catalog.providers) { try { configured.add(new URL(provider.baseUrl).origin) } catch {} }
  const allowed = new Set()
  for (const value of doctorOptions('--allow-private-origin')) {
    const url = safeHttpsUrl(value, '--allow-private-origin')
    if (url.href !== `${url.origin}/`) throw new Error('--allow-private-origin must be an HTTPS origin without a path, query, or fragment')
    if (!configured.has(url.origin)) throw new Error('--allow-private-origin must exactly match a configured discovery, public, or model origin')
    allowed.add(url.origin)
  }
  return allowed
}
function doctorOptions(name) { const values = []; for (let index = 0; index < argv.length; index += 1) if (argv[index] === name) { if (!argv[index + 1]) throw new Error(`missing ${name}`); values.push(argv[index + 1]) }; return values }
function doctorPrivateMode(url, allowedOrigins) { return allowedOrigins.has(url.origin) ? 'allow' : 'manual' }
function requestHead(url, options = {}) { return requestHttps(url, { ...options, method: 'HEAD', acceptHttpError: true }).then(() => undefined) }
function requestJson(url, options = {}) { return requestHttps(url, options).then((response) => { try { return JSON.parse(response.body) } catch { throw new Error(`invalid JSON response (HTTP ${String(response.statusCode)})`) } }) }
async function requestHttps(url, options = {}) {
  const target = safeHttpsUrl(url, 'doctor target')
  const configuredTimeout = Number(process.env.KALA_PRIVATE_CLOUD_DOCTOR_TIMEOUT_MS ?? 10_000)
  const timeout = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 10_000
  const ca = options.ca ? [...getCACertificates('default'), options.ca] : undefined
  const addresses = await doctorAddresses(target, options.privateMode ?? 'manual')
  const expectedAddresses = new Set(addresses.map((entry) => normalizedAddress(entry.address)))
  return new Promise((resolvePromise, rejectPromise) => {
    const lookup = (_hostname, lookupOptions, callback) => {
      const family = typeof lookupOptions === 'object' ? lookupOptions.family : 0
      const eligible = family ? addresses.filter((entry) => entry.family === family) : addresses
      if (!eligible.length) { callback(Object.assign(new Error('no approved address for requested DNS family'), { code: 'ENOTFOUND' })); return }
      if (typeof lookupOptions === 'object' && lookupOptions.all) callback(null, eligible)
      else callback(null, eligible[0].address, eligible[0].family)
    }
    const request = httpsRequest(target, { method: options.method ?? 'GET', headers: options.headers, ca, timeout, lookup, agent: false }, (response) => {
      const chunks = []; let bytes = 0
      response.on('data', (chunk) => { bytes += chunk.length; if (bytes <= 1_048_576) chunks.push(chunk); else request.destroy(new Error('response exceeds 1 MiB')) })
      response.on('end', () => {
        if (!options.acceptHttpError && (response.statusCode ?? 500) >= 400) rejectPromise(new Error(`HTTP ${String(response.statusCode)}`))
        else resolvePromise({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.once('socket', (socket) => socket.once('secureConnect', () => {
      if (!expectedAddresses.has(normalizedAddress(socket.remoteAddress ?? ''))) request.destroy(new Error('connected address was not in the validated DNS result'))
    }))
    request.once('timeout', () => request.destroy(new Error('connection timed out')))
    request.once('error', (error) => rejectPromise(new Error(`trusted TLS/network check failed${error?.code ? ` (${String(error.code)})` : ''}`)))
    request.end()
  })
}
async function doctorAddresses(url, privateMode) {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  let addresses
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await dnsLookup(hostname, { all: true, verbatim: true }) }
  catch (error) { throw new Error(`DNS lookup failed${error?.code ? ` (${String(error.code)})` : ''}`) }
  if (!addresses.length) throw new Error('DNS lookup returned no addresses')
  const addressKinds = addresses.map((entry) => doctorAddressKind(entry.address))
  if (addressKinds.includes('forbidden')) throw new Error('target resolved to a metadata, link-local, reserved, or otherwise forbidden address and was not requested')
  if (addressKinds.includes('private')) {
    if (privateMode === 'allow') return addresses
    const error = new Error(privateMode === 'deny' ? 'cross-origin OIDC metadata resolved to a private address and was not requested' : 'target resolved to a private address; rerun with an exact configured --allow-private-origin only after operator review')
    if (privateMode === 'manual') error.doctorStatus = 'manual'
    throw error
  }
  return addresses
}
function normalizedAddress(address) { return address.toLowerCase().replace(/^::ffff:/u, '') }
function doctorAddressKind(address) {
  const normalized = normalizedAddress(address)
  if (isIP(normalized) === 4) {
    const [a, b, c] = normalized.split('.').map(Number)
    if (a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private'
    if (a === 0 || (a === 169 && b === 254) || (a === 192 && (b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113) || a >= 224) return 'forbidden'
    return 'public'
  }
  if (isIP(normalized) === 6) {
    if (normalized === '::1' || /^(?:fc|fd)/u.test(normalized)) return 'private'
    return /^(?:2|3)[0-9a-f]{3}:/u.test(normalized) && !normalized.startsWith('2001:db8:') ? 'public' : 'forbidden'
  }
  return 'forbidden'
}
function doctorMessage(error, configDir) {
  let message = redact(error instanceof Error ? error.message : String(error))
  if (configDir) for (const name of secretNames) {
    const path = join(configDir, 'secrets', name)
    if (existsSync(path)) { const value = readFileSync(path, 'utf8').trim(); if (value) message = message.replaceAll(value, '[redacted]') }
  }
  message = message.replaceAll(/https?:\/\/[^\s"'<>]+/giu, (value) => displayUrl(value))
  return message.replaceAll(/Bearer\s+[^\s]+/giu, 'Bearer [redacted]').slice(0, 500)
}

function provisionOrganization() {
  const installation = installed()
  const release = loadRelease(requiredJson(activePath))
  const environment = deploymentEnv(installation.configDir)
  const ownerIssuer = validIdentityIssuer(required('--owner-issuer'), environment)
  const configuredIssuer = validIdentityIssuer(environment.OIDC_ISSUER ?? '', environment)
  if (ownerIssuer !== configuredIssuer) throw new Error('--owner-issuer must exactly match OIDC_ISSUER in deployment.env; use the issuer claim from the owner ID token')
  const ownerSubject = identityValue(required('--owner-subject'), '--owner-subject')
  const ownerEmail = required('--owner-email').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(ownerEmail)) throw new Error('--owner-email must be a valid email address; do not use it as --owner-subject unless the IdP exact sub claim is identical')
  const endsAt = new Date(required('--ends-at'))
  if (!Number.isFinite(endsAt.getTime()) || endsAt <= new Date()) throw new Error('--ends-at must be a valid future ISO date')
  const input = {
    PROVISION_OWNER_ISSUER: ownerIssuer,
    PROVISION_OWNER_SUBJECT: ownerSubject,
    PROVISION_OWNER_EMAIL: ownerEmail,
    PROVISION_OWNER_DISPLAY_NAME: option('--owner-display-name') ?? ownerEmail,
    PROVISION_ORGANIZATION_NAME: limited(required('--organization-name'), '--organization-name'),
    PROVISION_CONTRACT_REFERENCE: limited(required('--contract-reference'), '--contract-reference'),
    PROVISION_ENDS_AT: endsAt.toISOString(),
    PROVISION_OPERATION_ID: limited(required('--operation-id'), '--operation-id'),
    PROVISION_SEAT_LIMIT: positiveIntegerOption('--seat-limit', 10),
    PROVISION_CONCURRENT_SESSION_LIMIT: positiveIntegerOption('--concurrent-session-limit', 5),
  }
  const bootstrap = `const fs=require('node:fs');let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{Object.assign(process.env,JSON.parse(body));process.env.KALA_INGRESS_DATABASE_URL=fs.readFileSync('/run/kala-secrets/control_database_url','utf8').trim();import('file:///app/packages/runtime-ingress-gateway/dist/src/bin/provision-organization.js').catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exit(1)})})`
  compose(release, installation.configDir, ['exec', '-T', 'runtime-ingress', '/nodejs/bin/node', '-e', bootstrap], { input: Buffer.from(JSON.stringify(input)) })
}

function createOwnerBootstrap() {
  const installation = installed()
  const environment = deploymentEnv(installation.configDir)
  const ownerIssuer = validIdentityIssuer(required('--owner-issuer'), environment)
  const configuredIssuer = validIdentityIssuer(environment.OIDC_ISSUER ?? '', environment)
  if (ownerIssuer !== configuredIssuer) throw new Error('--owner-issuer must exactly match OIDC_ISSUER in deployment.env')
  const ownerEmail = required('--owner-email').trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(ownerEmail)) throw new Error('--owner-email must be a valid expected owner email')
  const endsAt = new Date(required('--ends-at'))
  if (!Number.isFinite(endsAt.getTime()) || endsAt <= new Date()) throw new Error('--ends-at must be a valid future ISO date')
  const publicOrigin = String(environment.KALA_PUBLIC_URLS ?? '').split(',').map((value) => value.trim()).find((value) => value && !value.includes('*'))
  if (!publicOrigin) throw new Error('KALA_PUBLIC_URLS must include an exact public HTTPS origin')
  ownerBootstrapCommand({
    OWNER_BOOTSTRAP_ACTION: 'create', OWNER_BOOTSTRAP_EXPECTED_ISSUER: ownerIssuer, OWNER_BOOTSTRAP_EXPECTED_EMAIL: ownerEmail,
    OWNER_BOOTSTRAP_ORGANIZATION_NAME: limited(required('--organization-name'), '--organization-name'),
    OWNER_BOOTSTRAP_CONTRACT_REFERENCE: limited(required('--contract-reference'), '--contract-reference'),
    OWNER_BOOTSTRAP_ENDS_AT: endsAt.toISOString(), OWNER_BOOTSTRAP_OPERATION_ID: limited(required('--operation-id'), '--operation-id'),
    OWNER_BOOTSTRAP_TTL_MINUTES: positiveIntegerOption('--ttl-minutes', 15), OWNER_BOOTSTRAP_SEAT_LIMIT: positiveIntegerOption('--seat-limit', 10),
    OWNER_BOOTSTRAP_CONCURRENT_SESSION_LIMIT: positiveIntegerOption('--concurrent-session-limit', 5), OWNER_BOOTSTRAP_PUBLIC_ORIGIN: publicOrigin,
  })
}

function ownerBootstrapStatus() {
  ownerBootstrapCommand({ OWNER_BOOTSTRAP_ACTION: 'status', OWNER_BOOTSTRAP_ID: identityValue(required('--authorization-id'), '--authorization-id') })
}

function confirmOwnerBootstrap() {
  ownerBootstrapCommand({
    OWNER_BOOTSTRAP_ACTION: 'confirm', OWNER_BOOTSTRAP_ID: identityValue(required('--authorization-id'), '--authorization-id'),
    OWNER_BOOTSTRAP_CONFIRMATION_CODE: identityValue(required('--confirmation-code'), '--confirmation-code'),
  })
}

function ownerBootstrapCommand(input) {
  const installation = installed()
  const release = loadRelease(requiredJson(activePath))
  const bootstrap = `const fs=require('node:fs');let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{Object.assign(process.env,JSON.parse(body));process.env.KALA_INGRESS_DATABASE_URL=fs.readFileSync('/run/kala-secrets/control_database_url','utf8').trim();import('file:///app/packages/runtime-ingress-gateway/dist/src/bin/owner-bootstrap.js').catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exit(1)})})`
  compose(release, installation.configDir, ['exec', '-T', 'runtime-ingress', '/nodejs/bin/node', '-e', bootstrap], { input: Buffer.from(JSON.stringify(input)) })
}

async function install() {
  if (existsSync(installationPath)) throw new Error('Private Cloud is already installed')
  ensureOperatorRoot()
  const configDir = bounded(required('--config-dir'), 'configuration directory')
  const bundle = bounded(required('--bundle'), 'bundle directory')
  if (deploymentEnv(configDir).KALA_STORAGE !== 'postgres-s3') throw new Error('new legacy local-volume/NFS installations are disabled; preserve existing installed projects and use external PostgreSQL/S3')
  await deploymentPreflight(bundle, configDir)
  const release = stageBundle(bundle)
  let receipt = begin('install', { releaseId: release.id })
  try {
    receipt = move(receipt, 'verified')
    compose(release, configDir, ['pull'])
    receipt = move(receipt, 'pulled')
    if (deploymentEnv(configDir).KALA_IDENTITY_MODE === 'bundled') {
      compose(release, configDir, ['up', '-d', '--wait', 'identity-proxy'])
      const invocation = composeInvocation(release, configDir, ['config', '--format', 'json'])
      const config = JSON.parse(captureSync(invocation.command, invocation.args, invocation.cwd, invocation.env))
      const volume = config.volumes?.['identity-zitadel-bootstrap']?.name ?? `${projectName(configDir)}_identity-zitadel-bootstrap`
      const image = config.services?.['identity-init']?.image
      if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/u.test(image ?? '')) throw new Error('bundled bootstrap image is not immutable')
      await bootstrapPrivateCloudIdentity({ configDir, bootstrapVolume: volume, identityImage: image })
      validateConfig(configDir, { requireClient: true })
    }
    compose(release, configDir, ['up', '-d', '--wait', '--remove-orphans'])
    receipt = move(receipt, 'services_updated')
    if (deploymentEnv(configDir).KALA_IDENTITY_MODE === 'bundled') await verifyBundledIdentity(configDir)
    const services = inspectServices(release, configDir)
    receipt = move(receipt, 'ready', { services })
    const installation = { schemaVersion: 1, installationId: requiredJson(join(configDir, configOriginName)).installationId, installedAt: now(), updatedAt: now(), configDir, projectName: projectName(configDir), storageMode: 'postgres-s3', composeTopology: 'postgres-s3-v1' }
    atomicJson(activePath, releaseRecord(release)); atomicJson(installationPath, installation)
    receipt = move(receipt, 'completed')
    output({ ok: true, installation, active: releaseRecord(release), services, receipt: publicReceipt(receipt) })
  } catch (error) {
    // A fresh PG/S3 project has no application data volumes. Remove its disposable
    // secret projections so the same installation UUID can pass fresh-project
    // preflight on retry; Compose never removes external PostgreSQL/S3 state.
    try { compose(release, configDir, ['down', '--remove-orphans', '--volumes']) } catch {}
    failed(receipt, error)
    throw error
  }
}

async function verifyBundledIdentity(configDir) {
  const { identity } = localPorts(deploymentEnv(configDir))
  const issuer = `http://localhost:${identity}`
  const get = (path) => new Promise((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${identity}${path}`, { headers: { Host: `localhost:${identity}` }, timeout: 6000 }, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk; if (body.length > 1_000_000) request.destroy(new Error('bundled identity response too large')) })
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`bundled identity ${path} returned HTTP ${response.statusCode}`))
        try { resolve(JSON.parse(body)) } catch { reject(new Error(`bundled identity ${path} returned invalid JSON`)) }
      })
    })
    request.on('timeout', () => request.destroy(new Error('bundled identity request timed out')))
    request.on('error', reject)
    request.end()
  })
  const discovery = await get('/.well-known/openid-configuration')
  if (discovery.issuer !== issuer || discovery.jwks_uri !== `${issuer}/oauth/v2/keys` || !discovery.authorization_endpoint) throw new Error('bundled identity discovery does not match the configured HTTP localhost issuer')
  const jwks = await get('/oauth/v2/keys')
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error('bundled identity has no JWKS signing keys')
}

function status() {
  const installation = optionalJson(installationPath); const active = optionalJson(activePath); const predecessor = optionalJson(predecessorPath)
  let services = null
  if (installation && active) { try { services = inspectServices(loadRelease(active), installation.configDir) } catch (error) { services = { error: redact(String(error)) } } }
  const receipts = existsSync(receiptsRoot) ? readdirSync(receiptsRoot).filter((name) => name.endsWith('.json')).map((name) => optionalJson(join(receiptsRoot, name))).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 5) : []
  output({ installed: Boolean(installation), installation, active, predecessor, services, recentOperations: receipts.map(publicReceipt) })
}

function upgrade(dashboardOnly) {
  const installation = installed(); refusePostgresS3Lifecycle(dashboardOnly ? 'upgrade-dashboard' : 'upgrade', installation.configDir); const current = loadRelease(requiredJson(activePath)); const candidate = stageBundle(required('--bundle'))
  if (candidate.id === current.id) throw new Error('candidate release is already active')
  if (dashboardOnly && (candidate.lock.images.runtime !== current.lock.images.runtime || candidate.lock.images.ingress !== current.lock.images.ingress)) throw new Error('Dashboard-only bundle changes Runtime or Ingress digest')
  if (dashboardOnly && candidate.lock.images.dashboard === current.lock.images.dashboard) throw new Error('Dashboard-only bundle does not change the Dashboard digest')
  let receipt = begin(dashboardOnly ? 'upgrade-dashboard' : 'upgrade', { from: current.id, to: candidate.id })
  try {
    receipt = move(receipt, 'verified')
    compose(candidate, installation.configDir, ['pull', ...(dashboardOnly ? ['dashboard'] : [])])
    receipt = move(receipt, 'pulled')
    const before = inspectServices(current, installation.configDir)
    if (dashboardOnly) compose(candidate, installation.configDir, ['up', '-d', '--no-deps', '--wait', 'dashboard'])
    else compose(candidate, installation.configDir, ['up', '-d', '--wait', '--remove-orphans'])
    receipt = move(receipt, 'services_updated')
    const after = inspectServices(candidate, installation.configDir)
    if (dashboardOnly && (before['runtime-host']?.containerId !== after['runtime-host']?.containerId || before['runtime-ingress']?.containerId !== after['runtime-ingress']?.containerId)) throw new Error('Dashboard-only upgrade changed Runtime or Ingress container identity')
    if (dashboardOnly && before.dashboard?.containerId === after.dashboard?.containerId) throw new Error('Dashboard-only upgrade did not replace the Dashboard container')
    receipt = move(receipt, 'ready', { services: after })
    atomicJson(predecessorPath, releaseRecord(current)); atomicJson(activePath, releaseRecord(candidate))
    receipt = move(receipt, 'completed')
    output({ ok: true, dashboardOnly, active: releaseRecord(candidate), predecessor: releaseRecord(current), services: after, receipt: publicReceipt(receipt) })
  } catch (error) {
    try { compose(current, installation.configDir, ['up', '-d', '--wait', '--remove-orphans']) } catch {}
    failed(receipt, error); throw error
  }
}

function rollback() {
  const installation = installed(); refusePostgresS3Lifecycle('rollback', installation.configDir); const current = loadRelease(requiredJson(activePath)); const predecessor = loadRelease(requiredJson(predecessorPath))
  let receipt = begin('rollback', { from: current.id, to: predecessor.id })
  try {
    receipt = move(receipt, 'verified'); compose(predecessor, installation.configDir, ['pull']); receipt = move(receipt, 'pulled')
    compose(predecessor, installation.configDir, ['up', '-d', '--wait', '--remove-orphans']); receipt = move(receipt, 'services_updated')
    const services = inspectServices(predecessor, installation.configDir); receipt = move(receipt, 'ready', { services })
    atomicJson(activePath, releaseRecord(predecessor)); atomicJson(predecessorPath, releaseRecord(current)); receipt = move(receipt, 'completed')
    output({ ok: true, active: releaseRecord(predecessor), predecessor: releaseRecord(current), services, receipt: publicReceipt(receipt) })
  } catch (error) { try { compose(current, installation.configDir, ['up', '-d', '--wait', '--remove-orphans']) } catch {}; failed(receipt, error); throw error }
}

async function backup() {
  const installation = installed(); refusePostgresS3Lifecycle('backup', installation.configDir); const release = loadRelease(requiredJson(activePath)); const destination = bounded(required('--output'), 'backup output')
  ensureEmpty(destination); const backupId = `backup-${randomUUID()}`; let receipt = begin('backup', { backupId, destination })
  const bundledIdentity = deploymentEnv(installation.configDir).KALA_IDENTITY_MODE === 'bundled'
  const applicationServices = ['runtime-ingress', 'runtime-host', 'dashboard', ...(bundledIdentity ? ['identity-proxy', 'identity-login', 'identity-zitadel-health', 'identity-zitadel'] : [])]
  let stopped = false
  try {
    receipt = move(receipt, 'verified')
    compose(release, installation.configDir, ['stop', ...applicationServices]); stopped = true; receipt = move(receipt, 'stopped')
    await capture(composeInvocation(release, installation.configDir, ['exec', '-T', 'control-postgres', 'pg_dump', '-U', 'runlab', '-d', 'runlab_control', '--format=custom', '--no-owner', '--no-acl']), join(destination, 'control-plane.pgdump'))
    if (bundledIdentity) await capture(composeInvocation(release, installation.configDir, ['exec', '-T', 'identity-postgres', 'pg_dump', '-U', 'zitadel', '-d', 'zitadel', '--format=custom', '--no-owner', '--no-acl']), join(destination, 'identity.pgdump'))
    const volumes = resolveVolumes(release, installation.configDir)
    const archives = [['tenant-data', 'tenant-data.tar'], ['control-data', 'control-data.tar'], ...(bundledIdentity ? [['identity-zitadel-config', 'identity-zitadel-config.tar'], ['identity-zitadel-bootstrap', 'identity-zitadel-bootstrap.tar']] : [])]
    for (const [logical, file] of archives) await capture({ command: 'docker', args: ['run', '--rm', '--network', 'none', '-v', `${volumes[logical]}:/source:ro`, infrastructure(release, 'alpine'), 'tar', '-C', '/source', '-cf', '-', '.'], cwd: release.dir, env: composeEnv(release, installation.configDir) }, join(destination, file))
    const files = {}; for (const name of ['control-plane.pgdump', ...(bundledIdentity ? ['identity.pgdump'] : []), ...archives.map(([, file]) => file)]) files[name] = await describeFile(join(destination, name))
    const manifest = { schemaVersion: 1, product: 'kala-private-cloud-backup', backupId, createdAt: now(), installationId: installation.installationId, projectName: installation.projectName, identityMode: bundledIdentity ? 'bundled' : 'external', active: releaseRecord(release), volumes, files }
    atomicJson(join(destination, 'manifest.json'), manifest); receipt = move(receipt, 'backup_completed', { files }); compose(release, installation.configDir, ['up', '-d', '--wait', ...applicationServices]); stopped = false; receipt = move(receipt, 'services_updated'); receipt = move(receipt, 'ready'); receipt = move(receipt, 'completed')
    output({ ok: true, backupId, confirmation: `RESTORE:${backupId}`, manifest: { files }, receipt: publicReceipt(receipt) })
  } catch (error) { if (stopped) { try { compose(release, installation.configDir, ['up', '-d', '--wait', ...applicationServices]) } catch {} }; failed(receipt, error); throw error }
}

async function restore() {
  const installation = installed(); refusePostgresS3Lifecycle('restore', installation.configDir); const current = loadRelease(requiredJson(activePath)); const backupDir = bounded(required('--backup'), 'backup directory'); const manifest = requiredJson(join(backupDir, 'manifest.json'))
  if (manifest.product !== 'kala-private-cloud-backup' || manifest.installationId !== installation.installationId) throw new Error('backup does not belong to this installation')
  if (required('--confirm') !== `RESTORE:${manifest.backupId}`) throw new Error(`confirmation must equal RESTORE:${manifest.backupId}`)
  const bundledIdentity = deploymentEnv(installation.configDir).KALA_IDENTITY_MODE === 'bundled'
  if (bundledIdentity !== (manifest.identityMode === 'bundled')) throw new Error('backup identity mode does not match installation; identity accounts must be restored with their database')
  const requiredFiles = ['control-plane.pgdump', 'tenant-data.tar', 'control-data.tar', ...(bundledIdentity ? ['identity.pgdump', 'identity-zitadel-config.tar', 'identity-zitadel-bootstrap.tar'] : [])]
  if (requiredFiles.some((name) => !manifest.files?.[name])) throw new Error('backup is missing required application or identity state')
  for (const [name, expected] of Object.entries(manifest.files ?? {})) { const actual = await describeFile(join(backupDir, name)); if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`backup integrity failed for ${name}`) }
  const release = loadRelease(manifest.active); let receipt = begin('restore', { backupId: manifest.backupId })
  try {
    // NFS-backed tenant-data must remain mountable while Docker restores its volume.
    const volumes = resolveVolumes(release, installation.configDir)
    for (const logical of requiredFiles.filter((name) => name.endsWith('.tar')).map((name) => name.slice(0, -4))) if (manifest.volumes?.[logical] !== volumes[logical]) throw new Error(`backup ${logical} volume does not match this installation`)
    receipt = move(receipt, 'verified'); compose(current, installation.configDir, ['stop', 'runtime-ingress', 'runtime-host', 'dashboard', ...(bundledIdentity ? ['identity-proxy', 'identity-login', 'identity-zitadel-health', 'identity-zitadel', 'identity-postgres'] : []), 'control-postgres']); receipt = move(receipt, 'stopped')
    for (const logical of requiredFiles.filter((name) => name.endsWith('.tar')).map((name) => name.slice(0, -4))) run('docker', ['run', '--rm', '--network', 'none', '-v', `${volumes[logical]}:/restore`, '-v', `${join(backupDir, `${logical}.tar`)}:/backup.tar:ro`, infrastructure(release, 'alpine'), 'sh', '-ceu', 'find /restore -mindepth 1 -delete; tar -xf /backup.tar -C /restore'])
    compose(release, installation.configDir, ['up', '-d', '--wait', 'control-postgres', ...(bundledIdentity ? ['identity-postgres'] : [])]);
    compose(release, installation.configDir, ['exec', '-T', 'control-postgres', 'sh', '-ceu', 'dropdb -U runlab --if-exists runlab_control; createdb -U runlab runlab_control; pg_restore --exit-on-error --no-owner --no-acl -U runlab -d runlab_control'], { input: readFileSync(join(backupDir, 'control-plane.pgdump')) })
    if (bundledIdentity) compose(release, installation.configDir, ['exec', '-T', 'identity-postgres', 'sh', '-ceu', 'dropdb -U zitadel --if-exists zitadel; createdb -U zitadel zitadel; pg_restore --exit-on-error --no-owner --no-acl -U zitadel -d zitadel'], { input: readFileSync(join(backupDir, 'identity.pgdump')) })
    receipt = move(receipt, 'restored'); compose(release, installation.configDir, ['up', '-d', '--wait', '--remove-orphans']); receipt = move(receipt, 'services_updated')
    const services = inspectServices(release, installation.configDir); receipt = move(receipt, 'ready', { services }); atomicJson(predecessorPath, releaseRecord(current)); atomicJson(activePath, releaseRecord(release)); receipt = move(receipt, 'completed')
    output({ ok: true, active: releaseRecord(release), services, receipt: publicReceipt(receipt) })
  } catch (error) { try { compose(current, installation.configDir, ['up', '-d', '--wait', '--remove-orphans']) } catch {}; failed(receipt, error); throw error }
}

function uninstall() {
  const installation = installed(); refusePostgresS3Lifecycle('uninstall', installation.configDir); if (required('--confirm') !== `UNINSTALL:${installation.installationId}`) throw new Error(`confirmation must equal UNINSTALL:${installation.installationId}`)
  const release = loadRelease(requiredJson(activePath)); let receipt = begin('uninstall', {})
  try { receipt = move(receipt, 'verified'); compose(release, installation.configDir, ['down', '--remove-orphans']); receipt = move(receipt, 'stopped'); rmSync(installationPath); rmSync(activePath); rmSync(predecessorPath, { force: true }); receipt = move(receipt, 'removed'); receipt = move(receipt, 'completed'); output({ ok: true, preserved: ['volumes', 'configuration', 'secrets', releasesRoot, receiptsRoot], receipt: publicReceipt(receipt) }) }
  catch (error) { failed(receipt, error); throw error }
}

function stageBundle(input) {
  const source = bounded(input, 'bundle'); const manifest = requiredJson(join(source, 'manifest.json')); verifyBundle(source, manifest)
  // Compose and Operator fixes may keep the same image digests; identify the entire verified release, not only its image lock.
  const id = `release-${manifest.version}-${manifest.revision.slice(0, 12)}-${hash(readFileSync(join(source, 'manifest.json'))).slice(0, 12)}`
  const target = join(releasesRoot, id)
  if (!existsSync(target)) {
    const staging = join(releasesRoot, `.staging-${id}-${randomUUID()}`)
    try { mkdirSync(staging, { mode: 0o755 }); for (const name of readdirSync(source)) copyFileSync(join(source, name), join(staging, name)); verifyBundle(staging, manifest); renameSync(staging, target); fsyncDirectory(releasesRoot) }
    finally { rmSync(staging, { recursive: true, force: true }) }
  }
  verifyBundle(target, manifest); return loadRelease({ releaseId: id, releaseDir: target })
}
function verifyBundle(dir, manifest = requiredJson(join(dir, 'manifest.json'))) {
  if (manifest.schemaVersion !== 1 || manifest.product !== 'kala-private-cloud' || !/^[0-9a-f]{40}$/u.test(manifest.revision)) throw new Error('invalid Private Cloud bundle manifest')
  const expected = Object.keys(manifest.files).concat('manifest.json').sort(); if (JSON.stringify(readdirSync(dir).sort()) !== JSON.stringify(expected)) throw new Error('bundle file set does not match manifest')
  for (const [name, value] of Object.entries(manifest.files)) { if (name.includes('/')) throw new Error('invalid bundle file path'); const path = join(dir, name); if (statSync(path).size !== value.bytes || hash(readFileSync(path)) !== value.sha256) throw new Error(`bundle integrity failed for ${name}`) }
  const lock = requiredJson(join(dir, 'image-lock.json')); if (lock.version !== manifest.version || lock.revision !== manifest.revision || !['runtime', 'ingress', 'dashboard'].every((key) => immutable(lock.images?.[key]))) throw new Error('invalid image lock')
  const composeText = readFileSync(join(dir, 'compose.yaml'), 'utf8'); if (/^\s+build:/mu.test(composeText)) throw new Error('release Compose contains source build')
  for (const match of composeText.matchAll(/^\s+image:\s+([^$\s][^\s]*)/gmu)) if (!immutable(match[1])) throw new Error(`release Compose image is not digest pinned: ${match[1]}`)
  if (!['KALA_RUNTIME_IMAGE', 'KALA_INGRESS_IMAGE', 'KALA_DASHBOARD_IMAGE'].every((name) => composeText.includes(name))) throw new Error('release Compose does not consume all component image locks')
  for (const name of ['compose.identity-local.yaml', 'identity-local.Caddyfile', 'bootstrap-private-cloud-identity.mjs']) if (!manifest.files[name]) throw new Error(`bundled identity asset is missing: ${name}`)
  const identityCompose = readFileSync(join(dir, 'compose.identity-local.yaml'), 'utf8')
  if (/^\s+build:/mu.test(identityCompose)) throw new Error('bundled identity must not build from source')
  for (const match of identityCompose.matchAll(/^\s+image:\s+([^$\s][^\s]*)/gmu)) if (!immutable(match[1])) throw new Error(`bundled identity image is not digest pinned: ${match[1]}`)
  if (!identityCompose.includes('127.0.0.1:${KALA_IDENTITY_PORT:-13002}:8080') || !identityCompose.includes('identity-local.Caddyfile')) throw new Error('bundled identity must publish loopback only and use the signed proxy configuration')
}
function loadRelease(record) { const dir = bounded(record.releaseDir, 'release directory'); const manifest = requiredJson(join(dir, 'manifest.json')); verifyBundle(dir, manifest); return { id: record.releaseId, dir, manifest, lock: requiredJson(join(dir, 'image-lock.json')) } }
function releaseRecord(release) { return { schemaVersion: 1, releaseId: release.id, releaseDir: release.dir, version: release.manifest.version, revision: release.manifest.revision, images: release.lock.images, activatedAt: now() } }

function compose(release, configDir, args, options = {}) {
  const execute = (parameters) => { const invocation = composeInvocation(release, configDir, parameters); return run(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, input: options.input }) }
  if (args[0] !== 'up' || !args.includes('--wait') || deploymentEnv(configDir).KALA_IDENTITY_MODE !== 'bundled') return execute(args)
  // Zitadel's own image has no HEALTHCHECK; its separately healthy probe and proxy do.
  const result = execute(args.filter((arg) => arg !== '--wait'))
  const checks = ['control-postgres', 'runtime-host', 'dashboard', 'runtime-ingress', 'identity-postgres', 'identity-zitadel-health', 'identity-login', 'identity-proxy']
  const requested = args.slice(1).filter((arg) => !arg.startsWith('-'))
  const targets = requested.length ? requested.filter((service) => checks.includes(service)) : checks
  if (!targets.length) throw new Error('Bundled identity Compose wait has no healthchecked services')
  execute(['up', '-d', '--no-deps', '--wait', ...targets])
  return result
}
function composeInvocation(release, configDir, args) { return { command: 'docker', args: ['compose', ...composeFiles(release, configDir), ...args], cwd: release.dir, env: composeEnv(release, configDir) } }
function composeFiles(release, configDir) {
  const profile = deploymentEnv(configDir).KALA_PROFILE ?? 'cloudflare'; const storage = deploymentEnv(configDir).KALA_STORAGE
  if (!['nfs', 'external-nfs', 'local-volume', 'postgres-s3'].includes(storage)) throw new Error('KALA_STORAGE must explicitly select a known mode; never fall back to a local Runtime authority')
  const files = storage === 'postgres-s3' ? ['compose.postgres-s3-base.yaml', 'compose.storage-postgres-s3.yaml'] : ['compose.yaml', storage === 'external-nfs' ? 'compose.storage-external-nfs.yaml' : storage === 'local-volume' ? 'compose.storage-local.yaml' : 'compose.storage-nfs.yaml']
  files.push(profile === 'local' ? 'compose.local.yaml' : 'compose.cloudflare.yaml')
  if (deploymentEnv(configDir).KALA_IDENTITY_MODE === 'bundled') files.push('compose.identity-local.yaml')
  if (existsSync(join(configDir, oidcCaName)) && existsSync(join(release.dir, 'compose.oidc-private-ca.yaml'))) files.push('compose.oidc-private-ca.yaml')
  return ['--project-name', projectName(configDir), '--env-file', join(configDir, 'deployment.env'), ...files.flatMap((file) => ['-f', join(release.dir, file)])]
}
function composeEnv(release, configDir) { const environment = deploymentEnv(configDir); return { ...process.env, ...environment, ...(environment.KALA_STORAGE === 'nfs' ? { KALA_NFS_LISTEN_ADDRESS: environment.KALA_NFS_LISTEN_ADDRESS ?? '127.0.0.1', KALA_NFS_PORT: String(localPorts(environment).nfs) } : {}), KALA_RUNTIME_IMAGE: release.lock.images.runtime, KALA_INGRESS_IMAGE: release.lock.images.ingress, KALA_DASHBOARD_IMAGE: release.lock.images.dashboard, KALA_SECRETS_DIR: join(configDir, 'secrets'), KALA_IDENTITY_SECRETS_DIR: join(configDir, 'identity-secrets'), KALA_PROVIDER_CATALOG_FILE: join(configDir, 'runtime-provider-catalog.json'), KALA_DEPLOYMENT_CONFIG_FILE: join(release.dir, 'deployment.json'), ...(environment.KALA_STORAGE === 'postgres-s3' ? { KALA_INSTALLATION_ID_FILE: join(configDir, installationIdName) } : {}), ...(existsSync(join(configDir, oidcCaName)) ? { KALA_OIDC_CA_FILE: join(configDir, oidcCaName) } : {}) } }
function inspectServices(release, configDir) { const invocation = composeInvocation(release, configDir, ['ps', '--format', 'json']); const result = captureSync(invocation.command, invocation.args, invocation.cwd, invocation.env); const rows = result.trim() ? result.trim().split(/\r?\n/u).map((line) => JSON.parse(line)) : []; return Object.fromEntries(rows.map((row) => [row.Service, { containerId: row.ID, image: row.Image, state: row.State, health: row.Health ?? '' }])) }
function resolveVolumes(release, configDir) { const text = captureSync('docker', ['compose', ...composeFiles(release, configDir), 'config', '--format', 'json'], release.dir, composeEnv(release, configDir)); const config = JSON.parse(text); const identity = deploymentEnv(configDir).KALA_IDENTITY_MODE === 'bundled'; return Object.fromEntries(['tenant-data', 'control-data', ...(identity ? ['identity-zitadel-config', 'identity-zitadel-bootstrap'] : [])].map((name) => [name, config.volumes?.[name]?.name ?? `${projectName(configDir)}_${name}`])) }
function infrastructure(release, name) { const composeText = readFileSync(join(release.dir, 'compose.yaml'), 'utf8'); const match = composeText.match(new RegExp(`image: (${name}(?::[^\s@]+)?@sha256:[0-9a-f]{64})`, 'u')); if (!match) throw new Error(`missing pinned ${name} infrastructure image`); return match[1] }

function begin(type, detail) { ensureOperatorRoot(); const receipt = { schemaVersion: 1, operationId: `operation-${randomUUID()}`, type, sequence: 0, phase: 'planned', createdAt: now(), updatedAt: now(), detail }; atomicJson(join(receiptsRoot, `${receipt.operationId}.json`), receipt); return receipt }
function move(receipt, phase, detail) { if (!transitions.get(receipt.phase)?.has(phase)) throw new Error(`invalid lifecycle transition ${receipt.phase} -> ${phase}`); const next = { ...receipt, sequence: receipt.sequence + 1, phase, updatedAt: now(), ...(detail ? { detail: { ...receipt.detail, ...detail } } : {}) }; atomicJson(join(receiptsRoot, `${receipt.operationId}.json`), next); return next }
function failed(receipt, error) { if (receipt.phase === 'completed' || receipt.phase === 'failed') return receipt; const next = { ...receipt, sequence: receipt.sequence + 1, phase: 'failed', updatedAt: now(), error: redact(error instanceof Error ? error.message : String(error)) }; atomicJson(join(receiptsRoot, `${receipt.operationId}.json`), next); return next }
function publicReceipt(receipt) { return receipt && { operationId: receipt.operationId, type: receipt.type, sequence: receipt.sequence, phase: receipt.phase, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt, error: receipt.error } }

function installed() { const value = requiredJson(installationPath); if (value.schemaVersion !== 1 || !value.installationId || !value.configDir) throw new Error('invalid installation record'); requireConfig(value.configDir); assertInstallationConfiguration(value, value.configDir); return value }
function assertInstallationConfiguration(installation, configDir) { const environment = deploymentEnv(configDir); if (installation.projectName && installation.projectName !== projectName(configDir)) throw new Error('configuration COMPOSE_PROJECT_NAME differs from the installed project; in-place project switching is forbidden'); if (installation.storageMode && installation.storageMode !== environment.KALA_STORAGE || !installation.storageMode && environment.KALA_STORAGE === 'postgres-s3') throw new Error('configuration storage mode differs from the installation record; use a fresh Operator root/project and leave legacy volumes untouched'); if (environment.KALA_STORAGE === 'postgres-s3' && installation.composeTopology !== 'postgres-s3-v1' || environment.KALA_STORAGE !== 'postgres-s3' && installation.composeTopology && installation.composeTopology !== 'legacy-v1') throw new Error('installation Compose topology differs from its recorded mode; never switch an existing project between legacy and PG/S3 roots') }
function refusePostgresS3Lifecycle(operation, configDir) { if (deploymentEnv(configDir).KALA_STORAGE === 'postgres-s3') throw new Error(`postgres-s3 evaluation refuses ${operation}: the volume lifecycle cannot protect or recover external PostgreSQL, S3, and runtime_state_master_key authority; coordinate and rehearse the external plan without using this command`) }
function requireConfig(dir) { for (const name of ['deployment.env', 'runtime-provider-catalog.json']) if (!existsSync(join(dir, name))) throw new Error(`configuration is missing ${name}`); if (!existsSync(join(dir, 'secrets'))) throw new Error('configuration is missing secrets directory'); validateOidcCa(dir) }
function validateConfig(dir, { requireClient = false } = {}) {
  requireConfig(dir)
  const environment = deploymentEnv(dir)
  if (!['local', 'cloudflare'].includes(environment.KALA_PROFILE)) throw new Error('KALA_PROFILE must be local or cloudflare')
  if (!['nfs', 'external-nfs', 'local-volume', 'postgres-s3'].includes(environment.KALA_STORAGE)) throw new Error('KALA_STORAGE must be nfs, external-nfs, local-volume, or postgres-s3')
  if (environment.KALA_STORAGE === 'external-nfs' && !environment.KALA_EXTERNAL_NFS_ADDRESS?.trim()) throw new Error('KALA_EXTERNAL_NFS_ADDRESS is required when KALA_STORAGE=external-nfs')
  if (environment.KALA_STORAGE === 'nfs') {
    const ports = localPorts(environment)
    if ((environment.KALA_NFS_LISTEN_ADDRESS ?? '127.0.0.1') !== '127.0.0.1' || ports.nfs === ports.app || environment.KALA_IDENTITY_MODE === 'bundled' && ports.nfs === ports.identity) throw new Error('local NFS must bind its own distinct 127.0.0.1 port, never a public interface or application port')
  }
  projectName(dir)
  const identity = environment.KALA_IDENTITY_MODE ?? 'external'
  if (!['bundled', 'external'].includes(identity)) throw new Error('KALA_IDENTITY_MODE must be bundled or external')
  validateStorageOrigin(dir, environment.KALA_STORAGE)
  if (environment.KALA_STORAGE === 'postgres-s3') validatePostgresS3Environment(environment, identity)
  if (identity === 'bundled') {
    const ports = localPorts(environment)
    if (ports.app === ports.identity || environment.KALA_PROFILE !== 'local' || environment.KALA_PUBLIC_URLS !== `http://localhost:${ports.app}` || environment.KALA_PUBLIC_LISTEN !== `127.0.0.1:${ports.app}` || environment.OIDC_ISSUER !== `http://localhost:${ports.identity}` || environment.OIDC_DISCOVERY_ORIGIN !== 'http://identity-proxy:8080') throw new Error('bundled identity requires matching localhost Kala and ZITADEL origins and loopback binding; use external OIDC for other origins')
    const identitySecrets = join(dir, 'identity-secrets')
    const directory = lstatSync(identitySecrets)
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)) throw new Error('identity-secrets must be a private real directory (0700)')
    for (const name of ['postgres_password', 'zitadel_masterkey', 'initial_human_password']) validateSecretFile(join(identitySecrets, name), name)
    if (readFileSync(join(identitySecrets, 'zitadel_masterkey')).length !== 32) throw new Error('zitadel_masterkey must contain exactly 32 bytes')
    const password = readFileSync(join(identitySecrets, 'initial_human_password'), 'utf8')
    if (password.length < 16 || !/[A-Z]/u.test(password) || !/[a-z]/u.test(password) || !/[0-9]/u.test(password) || !/[^A-Za-z0-9]/u.test(password) || /[\u0000-\u001f\u007f]/u.test(password)) throw new Error('initial_human_password must be at least 16 characters and contain uppercase, lowercase, a digit and a symbol (no control characters)')
    if (existsSync(join(dir, oidcCaName))) throw new Error('bundled loopback identity must not use an external OIDC CA')
  } else {
    if (placeholder(environment.OIDC_ISSUER ?? '') || placeholder(environment.OIDC_DISCOVERY_ORIGIN ?? '')) throw new Error('OIDC issuer configuration is still a placeholder; create an external IdP and OIDC client, then set its exact issuer and discovery URLs')
    validHttpsOrigin(environment.OIDC_ISSUER, 'OIDC_ISSUER in deployment.env')
    validHttpsOrigin(environment.OIDC_DISCOVERY_ORIGIN, 'OIDC_DISCOVERY_ORIGIN in deployment.env')
  }
  const publicUrls = (environment.KALA_PUBLIC_URLS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  if (publicUrls.length === 0) throw new Error('KALA_PUBLIC_URLS must contain at least one public application URL registered with the external OIDC client')
  for (const value of publicUrls) validPublicOrigin(value, environment.KALA_PROFILE)
  const secretsDir = join(dir, 'secrets')
  const secretDirectory = lstatSync(secretsDir)
  if (!secretDirectory.isDirectory() || secretDirectory.isSymbolicLink()) throw new Error('secrets must be a real directory, not a symlink')
  if ((secretDirectory.mode & 0o077) !== 0) throw new Error('secrets directory permissions must not allow group or other access (expected 0700)')
  for (const name of [...secretNames.filter((name) => environment.KALA_STORAGE !== 'postgres-s3' || name !== 'control_postgres_password'), ...tlsNames, ...(environment.KALA_STORAGE === 'postgres-s3' ? postgresS3SecretNames.filter((name) => name !== 'runtime_state_master_key') : [])]) validateSecretFile(join(secretsDir, name), name)
  if (environment.KALA_STORAGE === 'postgres-s3') validatePostgresS3Credentials(secretsDir, environment)
  for (const name of ['oidc_client_id', 'oidc_client_secret', 'llm_api_key']) {
    const value = readFileSync(join(secretsDir, name), 'utf8').trim()
    if (placeholder(value) && (name === 'llm_api_key' || identity === 'external' || requireClient)) throw new Error(`${name} is still a placeholder; supply the real value before deployment`)
  }
  const catalog = requiredJson(join(dir, 'runtime-provider-catalog.json'))
  if (catalog.version !== 1 || !Array.isArray(catalog.providers) || catalog.providers.length === 0) throw new Error('runtime-provider-catalog.json must contain at least one version 1 provider')
  for (const provider of catalog.providers) {
    let url
    try { url = new URL(provider.baseUrl) } catch { throw new Error(`provider ${String(provider.id ?? '<unknown>')} has an invalid baseUrl`) }
    if (['192.0.2.5', 'example.com', 'localhost'].includes(url.hostname)) throw new Error(`provider ${String(provider.id ?? '<unknown>')} baseUrl is still an example; configure a reachable LLM provider`)
    if (provider.credentialRef !== 'file:llm_api_key') throw new Error(`provider ${String(provider.id ?? '<unknown>')} must use credentialRef file:llm_api_key`)
  }
}
function validateStorageOrigin(dir, storageMode) {
  const path = join(dir, configOriginName)
  if (!existsSync(path)) {
    if (storageMode === 'postgres-s3') throw new Error('postgres-s3 requires a new init-config directory with a generated storage-origin record; legacy configuration cannot switch storage')
    return // Existing legacy installations predate this record; do not invalidate them.
  }
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('storage-origin record must be an owner-only regular file')
  const origin = requiredJson(path)
  if (origin.schemaVersion !== 1 || !origin.installationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(origin.installationId)) throw new Error('storage-origin record has an invalid installation identity')
  if (origin.storageMode !== storageMode) throw new Error('storage mode differs from original configuration; create a new configuration and preserve existing volumes/data')
  if (storageMode === 'postgres-s3') {
    const idPath = join(dir, installationIdName)
    const idFile = lstatSync(idPath)
    if (!idFile.isFile() || idFile.isSymbolicLink() || (idFile.mode & 0o077) || readFileSync(idPath, 'utf8').trim() !== origin.installationId) throw new Error('postgres-s3 installation-id file must match the original configuration identity')
  }
}
function validatePostgresS3Environment(environment, identity) {
  if (identity !== 'external') throw new Error('postgres-s3 evaluation requires external OIDC; bundled identity has local database authority')
  if (environment.KALA_PG_S3_EVALUATION_ACK !== '1') throw new Error('postgres-s3 requires KALA_PG_S3_EVALUATION_ACK=1 acknowledging fresh-project evaluation status')
  if (environment.KALA_PG_S3_EXTERNAL_BACKUP_ACK !== '1') throw new Error('postgres-s3 requires KALA_PG_S3_EXTERNAL_BACKUP_ACK=1 after defining an external PostgreSQL/S3 backup plan; this is not restore proof')
  if (!environment.COMPOSE_PROJECT_NAME || environment.COMPOSE_PROJECT_NAME === 'kala-private-cloud') throw new Error('postgres-s3 must use a new dedicated COMPOSE_PROJECT_NAME; in-place switching from local/NFS is forbidden')
  const roleNames = ['KALA_CONTROL_DML_ROLE', 'KALA_RUNTIME_DML_ROLE', 'KALA_RUNTIME_READER_ROLE']
  for (const name of roleNames) if (!/^[a-z_][a-z0-9_]*$/u.test(environment[name] ?? '')) throw new Error(`${name} must name an existing lowercase restricted PostgreSQL login role`)
  if (new Set(roleNames.map((name) => environment[name])).size !== roleNames.length) throw new Error('control writer, Runtime writer, and Runtime reader roles must be distinct')
  const endpoint = validHttpsOrigin(environment.KALA_S3_ENDPOINT ?? '', 'KALA_S3_ENDPOINT')
  if (!endpoint || !/^[a-z0-9][a-z0-9._-]*$/u.test(environment.KALA_S3_REGION ?? '') || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(environment.KALA_S3_BUCKET ?? '')) throw new Error('postgres-s3 requires a valid HTTPS S3 endpoint, region, and existing DNS-compatible bucket name')
  for (const name of postgresS3SecretNames) if (Object.hasOwn(environment, name.toUpperCase()) || Object.hasOwn(environment, `KALA_${name.toUpperCase()}`)) throw new Error(`${name} must be supplied only as a mode-0600 file, never in deployment.env`)
  if (Object.values(environment).some((value) => /postgres(?:ql)?:\/\//iu.test(value))) throw new Error('database URLs must not be stored in deployment.env; use the required mode-0600 secret files')
}
function validatePostgresS3Credentials(secretsDir, environment) {
  const keyPath = join(secretsDir, 'runtime_state_master_key')
  if (!existsSync(keyPath)) throw new Error('configuration is missing secrets/runtime_state_master_key; create and durably preserve exactly 32 raw random bytes')
  const keyInfo = lstatSync(keyPath)
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink() || (keyInfo.mode & 0o077) !== 0 || keyInfo.size !== 32) throw new Error('secrets/runtime_state_master_key must be a private regular file containing exactly 32 raw bytes; the Operator will not generate it')
  if (readFileSync(keyPath).subarray(0, 8).toString('ascii').startsWith('REPLACE_')) throw new Error('secrets/runtime_state_master_key is a placeholder; supply and durably preserve 32 raw random bytes')
  for (const name of ['runtime_s3_access_key_id', 'runtime_s3_secret_access_key', 'installation_claim_s3_access_key_id', 'installation_claim_s3_secret_access_key']) if (placeholder(readFileSync(join(secretsDir, name), 'utf8').trim())) throw new Error(`secrets/${name} is still a placeholder`)
  if (readFileSync(join(secretsDir, 'runtime_s3_access_key_id'), 'utf8').trim() === readFileSync(join(secretsDir, 'installation_claim_s3_access_key_id'), 'utf8').trim()) throw new Error('claim job and Runtime require distinct S3 access keys; forbid Runtime writes/deletes on the installation marker')
  const urls = new Map()
  for (const name of postgresS3SecretNames.filter((entry) => entry.includes('postgres'))) {
    let url
    try { url = new URL(readFileSync(join(secretsDir, name), 'utf8').trim()) } catch { throw new Error(`secrets/${name} must contain a valid PostgreSQL URL`) }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.hash) throw new Error(`secrets/${name} must contain a credentialed PostgreSQL URL without a fragment`)
    urls.set(name, url)
  }
  const username = (name) => { try { return decodeURIComponent(urls.get(name).username) } catch { throw new Error(`secrets/${name} has an invalid encoded PostgreSQL login role`) } }
  const controlOwner = urls.get('control_postgres_migration_owner_url'); const controlWriter = urls.get('control_postgres_writer_url')
  if (controlOwner.pathname !== '/runlab_control' || controlWriter.pathname !== '/runlab_control' || controlOwner.host !== controlWriter.host) throw new Error('external control PostgreSQL owner and writer URLs must select the same pre-created runlab_control database')
  if (username('control_postgres_migration_owner_url') === username('control_postgres_writer_url') || username('control_postgres_writer_url') !== environment.KALA_CONTROL_DML_ROLE) throw new Error('control migration owner and Gateway writer must use distinct credentials, and KALA_CONTROL_DML_ROLE must match the writer URL')
  const runtimeNames = ['runtime_postgres_owner_url', 'runtime_postgres_writer_url', 'runtime_postgres_reader_url']
  const runtimeUrls = runtimeNames.map((name) => urls.get(name)); const runtimeUsers = runtimeNames.map(username)
  if (runtimeUrls.some((url) => url.host !== runtimeUrls[0].host || url.pathname !== runtimeUrls[0].pathname) || runtimeUrls[0].pathname === '/') throw new Error('Runtime PostgreSQL owner, writer, and reader URLs must select the same pre-created Runtime database')
  if (new Set(runtimeUsers).size !== runtimeUsers.length || runtimeUsers[1] !== environment.KALA_RUNTIME_DML_ROLE || runtimeUsers[2] !== environment.KALA_RUNTIME_READER_ROLE) throw new Error('Runtime owner, writer, and reader credentials must be distinct and match the configured workload roles')
  if (controlOwner.host === runtimeUrls[0].host && controlOwner.pathname === runtimeUrls[0].pathname) throw new Error('control and Runtime PostgreSQL must use separate databases')
  if (new Set([username('control_postgres_migration_owner_url'), username('control_postgres_writer_url'), ...runtimeUsers]).size !== 5) throw new Error('control and Runtime PostgreSQL login credentials must remain isolated')
}
function deploymentEnv(dir) { const result = {}; for (const line of readFileSync(join(dir, 'deployment.env'), 'utf8').split(/\r?\n/u)) { const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u); if (match) result[match[1]] = match[2] } return result }
function validPort(value, label) { const port = Number(value); if (!/^[1-9][0-9]{3,4}$/u.test(String(value)) || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error(`${label} must be a TCP port from 1024 to 65535`); return port }
function localPorts(environment) {
  const listen = environment.KALA_PUBLIC_LISTEN ?? '127.0.0.1:13001'
  const match = listen.match(/^127\.0\.0\.1:([1-9][0-9]{3,4})$/u)
  if (!match) throw new Error('KALA_PUBLIC_LISTEN must bind 127.0.0.1:<port>; external publication belongs outside Kala')
  return { app: validPort(match[1], 'KALA_PUBLIC_LISTEN port'), identity: validPort(environment.KALA_IDENTITY_PORT ?? '13002', 'KALA_IDENTITY_PORT'), nfs: validPort(environment.KALA_NFS_PORT ?? '12049', 'KALA_NFS_PORT') }
}
function loopbackPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (error) => { if (error.code === 'EADDRINUSE') resolve(false); else reject(error) })
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close((error) => error ? reject(error) : resolve(true)))
  })
}
async function chooseLocalPorts() {
  for (const [app, identity] of [[13001, 13002], [13101, 13102], [13201, 13202]]) {
    if (await loopbackPortFree(app) && await loopbackPortFree(identity)) return { app, identity }
  }
  throw new Error('No free Kala/identity loopback port pair; use --app-port PORT --identity-port PORT after checking other services, and do not stop existing listeners')
}
async function chooseNfsPort(reserved) {
  for (const port of [12049, 12149, 12249]) if (!reserved.has(port) && await loopbackPortFree(port)) return port
  throw new Error('No free local NFS loopback port; specify --nfs-port PORT or use --storage local-volume after reviewing durability and backups')
}
async function assertPortsAvailable(configDir) {
  const environment = deploymentEnv(configDir)
  const ports = localPorts(environment)
  for (const [label, port] of [['Kala', ports.app], ...(environment.KALA_IDENTITY_MODE === 'bundled' ? [['bundled identity', ports.identity]] : []), ...(environment.KALA_STORAGE === 'nfs' ? [['local NFS', ports.nfs]] : [])]) {
    if (!await loopbackPortFree(port)) throw new Error(`${label} loopback port ${port} is already in use; existing services must not be stopped. Select unused ports before creating a new installation and keep the OIDC issuer/redirect URI consistent.`)
  }
}
function projectName(configDir) { const value = deploymentEnv(configDir).COMPOSE_PROJECT_NAME ?? 'kala-private-cloud'; if (!/^[a-z0-9][a-z0-9_-]+$/u.test(value)) throw new Error('invalid COMPOSE_PROJECT_NAME'); return value }
function ensureOperatorRoot() { mkdirSync(receiptsRoot, { recursive: true, mode: 0o700 }); mkdirSync(releasesRoot, { recursive: true, mode: 0o700 }) }
function acquireOperationLock() {
  ensureOperatorRoot(); const path = join(operatorRoot, 'operation.lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: now() })}\n`); fsyncSync(fd); return { fd, path } }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const owner = optionalJson(path); if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('another lifecycle operation holds an invalid lock')
      try { process.kill(owner.pid, 0); throw new Error(`another lifecycle operation is active (pid ${String(owner.pid)})`) }
      catch (probe) { if (probe?.code !== 'ESRCH') throw probe; unlinkSync(path) }
    }
  }
  throw new Error('could not acquire lifecycle operation lock')
}
function releaseOperationLock(lock) { if (!lock) return; try { closeSync(lock.fd) } finally { try { unlinkSync(lock.path) } catch {} } }
function ensureEmpty(path) { if (existsSync(path) && readdirSync(path).length) throw new Error('output directory must be empty'); mkdirSync(path, { recursive: true, mode: 0o700 }) }
function copyRequired(source, destination) { if (!existsSync(source)) throw new Error(`bundle is missing ${basename(source)}`); copyFileSync(source, destination) }
function generateTls(dir) {
  const serverExt = join(dir, '.runtime-host.ext'); const clientExt = join(dir, '.client.ext')
  writeFileSync(serverExt, 'subjectAltName=DNS:runtime-host\nextendedKeyUsage=serverAuth\n', { mode: 0o600 })
  writeFileSync(clientExt, 'extendedKeyUsage=clientAuth\n', { mode: 0o600 })
  try {
    openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '3650', '-subj', '/CN=Kala Private Cloud Internal CA', '-keyout', join(dir, 'internal_ca_key.pem'), '-out', join(dir, 'internal_ca.pem')])
    openssl(['req', '-newkey', 'rsa:3072', '-nodes', '-subj', '/CN=runtime-host', '-keyout', join(dir, 'runtime_host_key.pem'), '-out', join(dir, 'runtime_host.csr')])
    openssl(['x509', '-req', '-days', '825', '-in', join(dir, 'runtime_host.csr'), '-CA', join(dir, 'internal_ca.pem'), '-CAkey', join(dir, 'internal_ca_key.pem'), '-CAcreateserial', '-extfile', serverExt, '-out', join(dir, 'runtime_host.pem')])
    for (const [commonName, prefix] of [['runtime-ingress', 'ingress_client'], ['runtime-health', 'runtime_health']]) {
      openssl(['req', '-newkey', 'rsa:3072', '-nodes', '-subj', `/CN=${commonName}`, '-keyout', join(dir, `${prefix}_key.pem`), '-out', join(dir, `${prefix}.csr`)])
      openssl(['x509', '-req', '-days', '825', '-in', join(dir, `${prefix}.csr`), '-CA', join(dir, 'internal_ca.pem'), '-CAkey', join(dir, 'internal_ca_key.pem'), '-CAcreateserial', '-extfile', clientExt, '-out', join(dir, `${prefix}.pem`)])
    }
  } finally { for (const name of ['runtime_host.csr', 'ingress_client.csr', 'runtime_health.csr', 'internal_ca.srl', '.runtime-host.ext', '.client.ext']) rmSync(join(dir, name), { force: true }) }
}
function openssl(args) { const result = spawnSync('openssl', args, { encoding: 'utf8' }); if (result.error?.code === 'ENOENT') throw new Error('openssl is required to generate Private Cloud mTLS material'); if (result.status !== 0) throw new Error(`openssl failed while generating mTLS material: ${redact(result.stderr).trim()}`) }
function validateSecretFile(path, name) { if (!existsSync(path)) throw new Error(`configuration is missing secrets/${name}`); const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`secrets/${name} must be a regular file, not a symlink`); if ((info.mode & 0o077) !== 0) throw new Error(`secrets/${name} permissions must not allow group or other access (expected 0600)`); if (!readFileSync(path, 'utf8').trim()) throw new Error(`secrets/${name} must not be empty`) }
function validateOidcCa(dir) {
  const path = join(dir, oidcCaName)
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) return
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${oidcCaName} must be a regular file, not a symlink`)
  if ((info.mode & 0o077) !== 0 || (info.mode & 0o400) === 0) throw new Error(`${oidcCaName} must be owner-readable and must not allow group or other access (expected 0600 or 0400)`)
  const body = readFileSync(path, 'utf8')
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u.test(body)) throw new Error(`${oidcCaName} must contain CA certificates only, never a private key`)
  const pattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu
  const certificates = body.match(pattern)
  if (!certificates?.length || body.replace(pattern, '').trim()) throw new Error(`${oidcCaName} must contain only PEM-encoded CA certificates`)
  for (const certificate of certificates) {
    let parsed
    try { parsed = new X509Certificate(certificate) } catch { throw new Error(`${oidcCaName} contains an invalid X.509 certificate`) }
    if (!parsed.ca) throw new Error(`${oidcCaName} must contain CA certificates, not leaf certificates`)
  }
}
function placeholder(value) { return !value || /^(?:REPLACE_|.*<[^>]+>)/u.test(value) }
function validIdentityIssuer(value, environment) { return environment.KALA_IDENTITY_MODE === 'bundled' && value === `http://localhost:${localPorts(environment).identity}` ? value : validHttpsOrigin(value, 'OIDC issuer') }
function validHttpsOrigin(value, label) { let url; try { url = new URL(value) } catch { throw new Error(`${label} must be a valid https URL`) }; if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`${label} must be an https URL without credentials, query, or fragment`); return url.href.replace(/\/$/u, '') }
function validPublicOrigin(value, profile) { let url; try { url = new URL(value) } catch { throw new Error('KALA_PUBLIC_URLS contains an invalid URL') }; const localHttp = profile === 'local' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname); if ((url.protocol !== 'https:' && !localHttp) || url.username || url.password || url.search || url.hash || placeholder(value)) throw new Error('KALA_PUBLIC_URLS entries must be real HTTPS origins (HTTP is allowed only for local loopback profile)'); return url.origin }
function identityValue(value, label) { if (value !== value.trim() || !value || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must be the exact non-empty IdP claim, at most 255 characters; do not infer it from email`); return value }
function limited(value, label) { const trimmed = value.trim(); if (!trimmed || trimmed.length > 200) throw new Error(`${label} must contain 1 to 200 characters`); return trimmed }
function positiveIntegerOption(name, fallback) { const value = Number(option(name) ?? fallback); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`); return String(value) }
function option(name) { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1] }
function bounded(value, label) { const path = resolve(value); if (path === '/' || path.split('/').filter(Boolean).length < 2) throw new Error(`unsafe ${label}`); return path }
function required(name) { const index = argv.indexOf(name); if (index < 0 || !argv[index + 1]) throw new Error(`missing ${name}`); return argv[index + 1] }
function requiredJson(path) { const value = optionalJson(path); if (!value) throw new Error(`missing ${basename(path)}`); return value }
function optionalJson(path) { if (!existsSync(path)) return null; try { return JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error(`invalid ${basename(path)}`) } }
function immutable(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/u.test(value) }
function atomicJson(path, value) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.tmp-${process.pid}-${randomUUID()}`; const fd = openSync(temp, 'wx', 0o600); try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }; renameSync(temp, path); const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory) } finally { closeSync(directory) } }
function fsyncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
function hash(body) { return createHash('sha256').update(body).digest('hex') }
async function describeFile(path) { const digest = createHash('sha256'); await new Promise((ok, reject) => createReadStream(path).on('data', (chunk) => digest.update(chunk)).on('end', ok).on('error', reject)); return { bytes: statSync(path).size, sha256: digest.digest('hex') } }
function now() { return new Date().toISOString() }
function redact(value) { return String(value).replaceAll(/(token|secret|password|key)=([^\s]+)/giu, '$1=[redacted]').replaceAll(/postgresql:\/\/[^@\s]+@/giu, 'postgresql://[redacted]@') }
function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) }
function fail(message) { process.stderr.write(`${message}\n`); process.exit(1) }
function run(command, args, options = {}) { const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, input: options.input, encoding: options.input ? undefined : 'utf8', stdio: options.input ? ['pipe', 'inherit', 'inherit'] : 'inherit' }); if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}`); return result.stdout }
function captureSync(command, args, cwd = process.cwd(), env = process.env) { if (typeof cwd === 'boolean') cwd = process.cwd(); const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr || `${command} exited ${String(result.status)}`); return result.stdout }
async function capture(invocation, outputPath) { const fd = openSync(outputPath, 'wx', 0o600); try { await new Promise((ok, reject) => { const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, stdio: ['ignore', fd, 'inherit'] }); child.once('error', reject); child.once('exit', (code) => code === 0 ? ok() : reject(new Error(`${invocation.command} exited ${String(code)}`))) }); fsyncSync(fd) } finally { closeSync(fd) } }
