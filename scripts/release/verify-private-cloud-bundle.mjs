#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from '../../node_modules/.pnpm/node_modules/yaml/dist/index.js'

const releaseMode = process.argv.includes('--release')
const directoryArgument = process.argv.slice(2).find((argument) => argument !== '--release')
const directory = resolve(directoryArgument ?? 'release/private-cloud')
const manifest = json('manifest.json')
const lock = json('image-lock.json')
if (manifest.schemaVersion !== 1 || manifest.product !== 'kala-private-cloud' || !/^[0-9a-f]{40}$/u.test(manifest.revision)) fail('invalid bundle manifest identity')
if (lock.schemaVersion !== 1 || lock.product !== manifest.product || lock.version !== manifest.version || lock.revision !== manifest.revision) fail('image lock identity does not match manifest')
for (const [component, image] of Object.entries(lock.images ?? {})) if (!['runtime', 'ingress', 'dashboard'].includes(component) || !immutable(image)) fail(`invalid ${component} image digest`)
if (Object.keys(lock.images ?? {}).length !== 3) fail('image lock must contain exactly Runtime, Ingress, and Dashboard')
for (const [name, expected] of Object.entries(manifest.files ?? {})) {
  if (name.includes('/') || name === 'manifest.json') fail(`invalid manifest path ${name}`)
  const body = readFileSync(join(directory, name)); const actual = { bytes: statSync(join(directory, name)).size, sha256: createHash('sha256').update(body).digest('hex') }
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) fail(`bundle integrity failed for ${name}`)
}
const actualNames = readdirSync(directory).sort()
const expectedNames = Object.keys(manifest.files).concat('manifest.json').sort()
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) fail('bundle file set does not exactly match manifest')
const compose = yaml('compose.yaml')
const lockedServices = {
  'control-plane-init': 'KALA_INGRESS_IMAGE',
  'runtime-host': 'KALA_RUNTIME_IMAGE',
  'runtime-ingress': 'KALA_INGRESS_IMAGE',
  dashboard: 'KALA_DASHBOARD_IMAGE',
}
verifyComposeImages(compose, 'production Compose', lockedServices)
for (const name of ['compose.identity-local.yaml', 'identity-local.Caddyfile', 'bootstrap-private-cloud-identity.mjs']) if (!actualNames.includes(name)) fail(`bundled identity asset is missing: ${name}`)
if (!actualNames.includes('compose.storage-postgres-s3.yaml')) fail('PostgreSQL/S3 evaluation overlay is missing')
const postgresS3ComposeSource = readFileSync(join(directory, 'compose.storage-postgres-s3.yaml'), 'utf8')
for (const marker of ['!override', 'control_postgres_migration_owner_url', 'runtime_postgres_owner_url', 'runtime_state_master_key', 'KALA_INGRESS_LOGIN_STATE_STORE_KIND: postgres', 'fresh-storage-claim:', 'kala-fresh-storage-claim.js', 'KALA_INSTALLATION_ID_FILE:', 'service_completed_successfully', 'KALA_INSTALLATION_ID_FILE:?']) {
  if (!postgresS3ComposeSource.includes(marker)) fail(`PostgreSQL/S3 evaluation overlay is missing required marker: ${marker}`)
}
const identityComposeSource = readFileSync(join(directory, 'compose.identity-local.yaml'), 'utf8')
const identityCompose = yaml('compose.identity-local.yaml')
verifyComposeImages(identityCompose, 'bundled identity', {}, compose.services)
if (!identityComposeSource.includes('127.0.0.1:${KALA_IDENTITY_PORT:-13002}:8080') || !identityComposeSource.includes('identity-local.Caddyfile')) fail('bundled identity must publish loopback only and use the signed proxy configuration')
if (actualNames.includes('compose.dev.yaml')) fail('source-build override must not ship')
const operators = actualNames.filter((name) => name === 'kala-private-cloud' || name === 'kala-private-cloud.mjs')
if (operators.length !== 1) fail('bundle must contain exactly one operator executable')
if (releaseMode && operators[0] !== 'kala-private-cloud') fail('release bundle must contain exactly the native kala-private-cloud executable')
accessSync(join(directory, operators[0]), constants.X_OK)
if (releaseMode) verifyLinuxX64Elf(join(directory, operators[0]))
process.stdout.write(`${JSON.stringify({ ok: true, releaseMode, version: manifest.version, revision: manifest.revision, images: lock.images, files: actualNames.length })}\n`)

function json(name) { try { return JSON.parse(readFileSync(join(directory, name), 'utf8')) } catch { fail(`invalid ${name}`) } }
function yaml(name) { try { const value = parseYaml(readFileSync(join(directory, name), 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value } catch { fail(`invalid ${name}`) } }
function verifyComposeImages(document, label, locked = {}, baseServices = {}) {
  const services = document.services
  if (!services || typeof services !== 'object' || Array.isArray(services)) fail(`${label} has no services`)
  for (const [name, service] of Object.entries(services)) {
    if (!service || typeof service !== 'object' || Array.isArray(service)) fail(`${label} service ${name} is invalid`)
    if ('build' in service || 'extends' in service) fail(`${label} contains build or extends`)
    if (service.image === undefined && baseServices[name]?.image) continue // Compose overlay only
    if (typeof service.image !== 'string') fail(`${label} service ${name} has no image`)
    const variable = locked[name]
    if (variable) {
      if (!new RegExp(`^\\$\\{${variable}:\\?[^}]+\\}$`, 'u').test(service.image)) fail(`${label} service ${name} does not consume ${variable}`)
    } else if (!immutable(service.image)) fail(`${label} image is not digest pinned: ${service.image}`)
  }
  for (const name of Object.keys(locked)) if (!Object.hasOwn(services, name)) fail(`${label} is missing locked service ${name}`)
}
function verifyLinuxX64Elf(path) {
  const body = readFileSync(path)
  const node = readFileSync(process.execPath)
  if (body.length < 24 || body[0] !== 0x7f || body.subarray(1, 4).toString('ascii') !== 'ELF' || body[4] !== 2 || body[5] !== 1 || body[6] !== 1 || ![2, 3].includes(body.readUInt16LE(16)) || body.readUInt16LE(18) !== 62 || body.readUInt32LE(20) !== 1) fail('release Operator must have a Linux ELF64 x86-64 header')
  if (body.length === node.length && createHash('sha256').update(body).digest('hex') === createHash('sha256').update(node).digest('hex')) fail('release Operator must not be the Node executable')
}
function immutable(value) { return typeof value === 'string' && /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/u.test(value) }
function fail(message) { process.stderr.write(`FAIL ${message}\n`); process.exit(1) }
