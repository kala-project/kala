#!/usr/bin/env node
import { access, readFile, stat, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { composeArgs, identityDeploymentEnv, root, selectedProfile } from './profile.mjs'

const profile = selectedProfile()
const failures = []
const warnings = []
const secretDir = resolve(root, process.env.KALA_SECRETS_DIR ?? 'deploy/private-cloud/.secrets')
const requiredSecrets = [...(profile === 'postgres-s3' ? [] : ['control_postgres_password']), 'session_secret', 'ingress_secret', 'oidc_client_id', 'oidc_client_secret', 'llm_api_key',
  ...(profile === 'postgres-s3' ? ['control_postgres_migration_owner_url', 'control_postgres_writer_url', 'runtime_postgres_owner_url', 'runtime_postgres_writer_url', 'runtime_postgres_reader_url', 'runtime_s3_access_key_id', 'runtime_s3_secret_access_key', 'installation_claim_s3_access_key_id', 'installation_claim_s3_secret_access_key'] : [])]
for (const name of requiredSecrets) {
  const path = resolve(secretDir, name)
  try {
    await access(path, constants.R_OK)
    const info = await stat(path)
    if ((info.mode & 0o077) !== 0) failures.push(`${path} permissions must deny group/other access`)
    const value = (await readFile(path, 'utf8')).trim()
    if (!value || value.startsWith('REPLACE_')) failures.push(`${path} is empty or placeholder`)
  } catch { failures.push(`missing secret file ${path}`) }
}
if (profile === 'postgres-s3') {
  const connectionSecrets = ['control_postgres_migration_owner_url', 'control_postgres_writer_url', 'runtime_postgres_owner_url', 'runtime_postgres_writer_url', 'runtime_postgres_reader_url']
  const connectionUrls = new Map()
  for (const name of connectionSecrets) {
    try {
      const value = (await readFile(resolve(secretDir, name), 'utf8')).trim()
      const url = new URL(value)
      if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') failures.push(`${name} must contain a PostgreSQL URL`)
      connectionUrls.set(name, url)
    } catch { failures.push(`${name} must contain a valid PostgreSQL URL`) }
  }
  const controlOwnerUrl = connectionUrls.get('control_postgres_migration_owner_url')
  const controlWriterUrl = connectionUrls.get('control_postgres_writer_url')
  const controlRole = process.env.KALA_CONTROL_DML_ROLE
  if (!controlRole || !/^[a-z_][a-z0-9_]*$/u.test(controlRole) || controlRole !== controlWriterUrl?.username) {
    failures.push('KALA_CONTROL_DML_ROLE must be the existing lowercase Gateway writer login role in control_postgres_writer_url')
  }
  if (controlOwnerUrl?.pathname !== '/runlab_control' || controlWriterUrl?.pathname !== '/runlab_control') {
    failures.push('external control PostgreSQL URLs must select the pre-created runlab_control database')
  }
  if (controlOwnerUrl && controlWriterUrl && (controlOwnerUrl.username === controlWriterUrl.username || controlOwnerUrl.href === controlWriterUrl.href)) {
    failures.push('control PostgreSQL migration-owner and Gateway writer login roles must be distinct')
  }
  if (controlOwnerUrl && controlWriterUrl && (controlOwnerUrl.host !== controlWriterUrl.host || controlOwnerUrl.pathname !== controlWriterUrl.pathname)) {
    failures.push('control PostgreSQL migration-owner and Gateway writer URLs must select the same pre-created database')
  }
  const runtimeOwnerUrl = connectionUrls.get('runtime_postgres_owner_url')
  if (controlOwnerUrl && runtimeOwnerUrl && controlOwnerUrl.host === runtimeOwnerUrl.host && controlOwnerUrl.pathname === runtimeOwnerUrl.pathname) {
    failures.push('control and Runtime PostgreSQL must use separate databases')
  }
  if (!process.env.COMPOSE_PROJECT_NAME || process.env.COMPOSE_PROJECT_NAME === 'kala-private-cloud') {
    failures.push('postgres-s3 must use a new, dedicated COMPOSE_PROJECT_NAME; in-place switching from local/NFS has no supported data migration')
  }
  try {
    const claimAccess = (await readFile(resolve(secretDir, 'installation_claim_s3_access_key_id'), 'utf8')).trim()
    const runtimeAccess = (await readFile(resolve(secretDir, 'runtime_s3_access_key_id'), 'utf8')).trim()
    if (claimAccess === runtimeAccess) failures.push('claim job and Runtime must have distinct S3 access keys; deny Runtime writes/deletes to the installation marker key')
  } catch { /* Missing credentials are reported by the required-secret check above. */ }
  const masterKey = resolve(secretDir, 'runtime_state_master_key')
  try {
    const info = await stat(masterKey)
    if ((info.mode & 0o077) !== 0 || info.size !== 32) failures.push('runtime_state_master_key must be a 32-byte raw key readable only by its owner')
  } catch { failures.push(`missing secret file ${masterKey}`) }
  if (process.env.KALA_PG_S3_EXTERNAL_BACKUP_ACK !== '1') {
    failures.push('postgres-s3 requires KALA_PG_S3_EXTERNAL_BACKUP_ACK=1 after configuring external PostgreSQL + S3 backup/restore; the built-in volume backup is incompatible')
  }
}
const compose = spawnSync('docker', ['compose', ...composeArgs(profile), 'config'], { cwd: root, encoding: 'utf8', env: process.env })
if (compose.status !== 0) failures.push(`compose config failed: ${compose.stderr.trim()}`)
else {
  if (/0\.0\.0\.0:13001/u.test(compose.stdout)) failures.push('runtime ingress must bind to loopback')
  if (compose.stdout.includes('/var/run/docker.sock')) failures.push('Docker socket mount is forbidden')
  if (profile === 'postgres-s3') {
    const config = spawnSync('docker', ['compose', ...composeArgs(profile), 'config', '--format', 'json'], { cwd: root, encoding: 'utf8', env: process.env })
    if (config.status !== 0) failures.push(`postgres-s3 Compose rendering failed: ${config.stderr.trim()}`)
    else {
      const services = JSON.parse(config.stdout).services ?? {}
      const runtime = services['runtime-host']
      const persistentRoot = runtime?.volumes?.some((volume) => volume.target === '/var/lib/kala')
      const scratchRoot = runtime?.tmpfs?.some((mount) => mount.split(':', 1)[0] === '/var/lib/kala')
      if (persistentRoot || !scratchRoot) failures.push('postgres-s3 runtime-host must have disposable /var/lib/kala tmpfs and no persistent data-root mount')
      const ingress = services['runtime-ingress']
      if (ingress?.volumes?.some((volume) => volume.target === '/var/lib/kala-control')) failures.push('postgres-s3 runtime-ingress must not mount control-data')
      if (ingress?.environment?.KALA_INGRESS_LOGIN_STATE_STORE_KIND !== 'postgres') failures.push('postgres-s3 login state must use the external control PostgreSQL database')
      for (const [name, service, flag] of [['runtime-host', runtime, 'KALA_RUNTIME_REQUIRE_INSTALLATION_CLAIM'], ['runtime-ingress', ingress, 'KALA_INGRESS_REQUIRE_INSTALLATION_CLAIM']]) {
        if (service?.environment?.[flag] !== '1' || service?.environment?.KALA_INSTALLATION_ID_FILE !== '/run/kala-installation/installation-id' || !service?.configs?.some((entry) => entry.source === 'installation_id' && entry.target === '/run/kala-installation/installation-id')) failures.push(`postgres-s3 ${name} must validate its external installation claim at startup`)
      }
      for (const name of ['init-volumes', 'control-postgres']) {
        if (services[name]) failures.push(`postgres-s3 must keep legacy ${name} inactive`)
      }
      const controlInit = services['control-plane-init']
      const runtimeInit = services['runtime-schema-init']
      const claim = services['fresh-storage-claim']
      if (controlInit?.environment?.KALA_INGRESS_REQUIRE_EXISTING_DATABASE !== '1' || controlInit?.environment?.KALA_INGRESS_CONTROL_WRITER_ROLE !== controlRole || !claim || claim.volumes?.length || !claim.configs?.some((config) => config.source === 'installation_id') || [controlInit, runtimeInit].some((job) => Object.keys(job?.depends_on ?? {}).join(',') !== 'fresh-storage-claim' || job.depends_on['fresh-storage-claim']?.condition !== 'service_completed_successfully')) {
        failures.push('postgres-s3 migrations must wait for a successful fresh external storage claim without local persistent claim state')
      }
      if (claim?.environment?.KALA_FRESH_CLAIM_S3_ACCESS_KEY_ID_FILE !== '/run/secrets/installation_claim_s3_access_key_id' || claim?.environment?.KALA_FRESH_CLAIM_S3_SECRET_ACCESS_KEY_FILE !== '/run/secrets/installation_claim_s3_secret_access_key' || !['installation_claim_s3_access_key_id', 'installation_claim_s3_secret_access_key'].every((name) => claim?.secrets?.some((secret) => secret.source === name))) {
        failures.push('postgres-s3 claim job must use its separate S3 bootstrap credentials')
      }
    }
  }
}
const isPublicProfile = profile === 'cloudflare' || profile === 'external-nfs'
const publicUrls = process.env.KALA_PUBLIC_URLS ?? (isPublicProfile ? '' : 'http://localhost:13001')
const publicOrigin = publicUrls.split(',').map((value) => value.trim()).find((value) => value && !value.includes('*')) ?? ''
const issuer = process.env.OIDC_ISSUER ?? ''
if (profile !== 'postgres-s3') {
  try {
    await access(identityDeploymentEnv, constants.R_OK)
    const identityEnv = await readFile(identityDeploymentEnv, 'utf8')
    if (!/^IDENTITY_DOMAIN=\S+/mu.test(identityEnv)) failures.push(`${identityDeploymentEnv} must define IDENTITY_DOMAIN`)
  } catch { failures.push(`Shared Identity deployment environment is missing: ${identityDeploymentEnv}`) }
  const identity = spawnSync('docker', ['compose', '--env-file', identityDeploymentEnv, '-f', 'deploy/identity/compose.yaml', 'ps', '--status', 'running', '--services'], { cwd: root, encoding: 'utf8', env: process.env })
  const identityServices = new Set(identity.stdout.trim().split('\n').filter(Boolean))
  if (identity.status !== 0 || !identityServices.has('zitadel') || !identityServices.has('zitadel-login') || !identityServices.has('caddy')) failures.push('Shared Identity Compose project must be running before Private Cloud deployment')
}
if (isPublicProfile && !publicOrigin) failures.push('KALA_PUBLIC_URLS must contain an exact URL for public profiles')
if (!issuer) failures.push('OIDC_ISSUER is required')
if (isPublicProfile && !publicOrigin.startsWith('https://')) failures.push('public profile requires an HTTPS URL in KALA_PUBLIC_URLS')
try {
  const response = await fetch(`${issuer.replace(/\/$/u, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) failures.push(`OIDC discovery returned ${response.status}`)
  else if ((await response.json()).issuer !== issuer.replace(/\/$/u, '')) failures.push('OIDC discovery issuer mismatch')
} catch (error) { failures.push(`OIDC discovery failed: ${error.message}`) }
const providerPath = resolve(root, process.env.KALA_PROVIDER_CATALOG_FILE ?? 'deploy/private-cloud/local/runtime-provider-catalog.json')
try { JSON.parse(await readFile(providerPath, 'utf8')) } catch (error) { failures.push(`provider catalog invalid: ${error.message}`) }
const disk = await statfs(root)
const free = disk.bavail * disk.bsize
if (free < 5 * 1024 ** 3) warnings.push(`less than 5 GiB free at ${root}`)
if (profile.includes('nfs') && !process.env.KALA_EXTERNAL_NFS_ADDRESS && profile === 'external-nfs') failures.push('KALA_EXTERNAL_NFS_ADDRESS is required')
for (const warning of warnings) console.warn(`WARN ${warning}`)
for (const failure of failures) console.error(`FAIL ${failure}`)
if (failures.length) process.exit(1)
console.log(`PASS preflight profile=${profile} publicOrigin=${publicOrigin} callback=${publicOrigin}/auth/callback`)
