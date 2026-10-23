import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const image = (name, character) => `ghcr.io/example/${name}@sha256:${character.repeat(64)}`

test('fresh init-config rejects every legacy storage mode without creating local or NFS configuration', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-config-legacy-'))
  const bundle = join(scratch, 'bundle')
  build(bundle)
  const cli = join(bundle, 'kala-private-cloud.mjs')

  for (const storage of ['nfs', 'local-volume', 'external-nfs']) {
    const config = join(scratch, storage)
    const appPort = await freePort()
    const result = run(process.execPath, [cli, 'init-config', '--bundle', bundle, '--config-dir', config, '--profile', 'cloudflare', '--identity', 'external', '--storage', storage, '--acknowledge-legacy-storage', '--app-port', String(appPort)], {
      allowFailure: true,
      env: { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: join(scratch, `operator-${storage}`) },
    })
    assert.notEqual(result.status, 0, `${storage} must not be available to fresh init-config`)
    assert.match(result.stderr, /fresh|postgres-s3|legacy/iu)
    assert.equal(existsSync(config), false, `${storage} rejection must not create a configuration directory`)
  }
})

test('fresh postgres-s3 init-config writes nothing when identity or acknowledgements are missing', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-config-prerequisites-'))
  const bundle = join(scratch, 'bundle')
  build(bundle)
  const cli = join(bundle, 'kala-private-cloud.mjs')
  const cases = [
    { name: 'bundled-identity', args: ['--identity', 'bundled', '--acknowledge-evaluation', '--acknowledge-external-backup'] },
    { name: 'evaluation-ack', args: ['--identity', 'external', '--acknowledge-external-backup'] },
    { name: 'backup-ack', args: ['--identity', 'external', '--acknowledge-evaluation'] },
  ]

  for (const prerequisite of cases) {
    const config = join(scratch, prerequisite.name)
    const result = run(process.execPath, [cli, 'init-config', '--bundle', bundle, '--config-dir', config, '--storage', 'postgres-s3', ...prerequisite.args], {
      allowFailure: true,
      env: { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: join(scratch, `operator-${prerequisite.name}`) },
    })
    assert.notEqual(result.status, 0)
    assert.equal(existsSync(config), false, `${prerequisite.name} failure must not leave partial configuration`)
  }
})

test('init-config never overwrites a non-empty configuration directory', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-private-cloud-config-preserve-'))
  const config = join(scratch, 'config')
  mkdirSync(config)
  writeFileSync(join(config, 'keep'), 'operator data')
  const result = run(process.execPath, [join(root, 'scripts/deploy/kala-private-cloud.mjs'), 'init-config', '--bundle', scratch, '--config-dir', config, '--profile', 'cloudflare', '--identity', 'external', '--storage', 'postgres-s3', '--acknowledge-evaluation', '--acknowledge-external-backup'], {
    allowFailure: true,
    env: { ...process.env, KALA_PRIVATE_CLOUD_OPERATOR_ROOT: join(scratch, 'operator') },
  })
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(join(config, 'keep'), 'utf8'), 'operator data')
})

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

function build(output) {
  run(process.execPath, ['scripts/release/build-private-cloud-bundle.mjs', '--output', output, '--runtime-image', image('runtime', 'a'), '--ingress-image', image('ingress', 'b'), '--dashboard-image', image('dashboard', 'c'), '--revision', '1'.repeat(40)])
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: options.env ?? process.env })
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${command} failed: ${result.stderr}`)
  return result
}
