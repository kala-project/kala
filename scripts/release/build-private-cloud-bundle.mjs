#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '../..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const output = resolve(option('--output') ?? join(root, 'release/private-cloud'))
const revision = option('--revision') ?? git('rev-parse', 'HEAD')
const images = {
  runtime: requiredImage('--runtime-image'),
  ingress: requiredImage('--ingress-image'),
  dashboard: requiredImage('--dashboard-image'),
}
const operator = resolve(option('--operator') ?? join(root, 'scripts/deploy/kala-private-cloud.mjs'))
const operatorName = operator.endsWith('.mjs') ? 'kala-private-cloud.mjs' : 'kala-private-cloud'
if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error('revision must be an exact 40-character Git revision')
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true, mode: 0o755 })
const files = [
  'deploy/private-cloud/compose.yaml',
  'deploy/private-cloud/compose.postgres-s3-base.yaml',
  'deploy/private-cloud/compose.oidc-private-ca.yaml',
  'deploy/private-cloud/compose.storage-nfs.yaml',
  'deploy/private-cloud/compose.storage-external-nfs.yaml',
  'deploy/private-cloud/compose.storage-local.yaml',
  'deploy/private-cloud/compose.storage-postgres-s3.yaml',
  'deploy/private-cloud/compose.local.yaml',
  'deploy/private-cloud/compose.cloudflare.yaml',
  'deploy/private-cloud/compose.identity-local.yaml',
  'deploy/private-cloud/identity-local/Caddyfile',
  'scripts/deploy/bootstrap-private-cloud-identity.mjs',
  'deploy/private-cloud/deployment.json',
  'deploy/private-cloud/local.env.example',
  'deploy/private-cloud/cloudflare.env.example',
  'deploy/private-cloud/local/runtime-provider-catalog.json',
]
function bundleName(source) { return source.endsWith('/runtime-provider-catalog.json') ? 'runtime-provider-catalog.example.json' : source.endsWith('/identity-local/Caddyfile') ? 'identity-local.Caddyfile' : basename(source) }
for (const source of files) copyFileSync(join(root, source), join(output, bundleName(source)))
// The Caddy image must be able to read the public proxy configuration even
// when the source checkout created it with owner-only permissions.
chmodSync(join(output, 'identity-local.Caddyfile'), 0o644)
copyFileSync(operator, join(output, operatorName))
chmodSync(join(output, operatorName), 0o755)
const imageLock = { schemaVersion: 1, product: 'kala-private-cloud', version: pkg.version, revision, images }
writeFileSync(join(output, 'image-lock.json'), `${JSON.stringify(imageLock, null, 2)}\n`)
const names = files.map(bundleName).concat('image-lock.json', operatorName).sort()
const manifest = {
  schemaVersion: 1, product: 'kala-private-cloud', version: pkg.version, revision,
  files: Object.fromEntries(names.map((name) => [name, describe(join(output, name))])),
}
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
const archive = option('--archive')
if (archive) run('tar', ['-czf', resolve(archive), '-C', output, '.'])
process.stdout.write(`${JSON.stringify({ ok: true, output, version: pkg.version, revision, images, files: Object.keys(manifest.files).length + 1 }, null, 2)}\n`)

function option(name) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function requiredImage(name) {
  const value = option(name)
  if (!value || !/^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${name} must be an immutable registry name@sha256 digest`)
  return value
}
function describe(path) { const body = readFileSync(path); return { bytes: statSync(path).size, sha256: createHash('sha256').update(body).digest('hex') } }
function git(...args) { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim() }
function run(command, args) { const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' }); if (result.status !== 0) throw new Error(`${command} exited ${String(result.status)}`) }
