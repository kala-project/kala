import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  generatePosixPortableManager,
  generateWindowsPortableManager,
  POSIX_PORTABLE_MANAGER,
  WINDOWS_PORTABLE_MANAGER,
} from './portable-manager.mjs'

const identity = { repo: 'example/kala', tag: 'v1.2.3' }
const asset = 'kala-dashboard-with-runtime.cjs'

function runtimeFixture(label, { exits = false } = {}) {
  return `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.KALA_PORTABLE_TEST_ENV) fs.writeFileSync(process.env.KALA_PORTABLE_TEST_ENV, JSON.stringify({ label: ${JSON.stringify(label)}, bind: process.env.KALA_BIND_HOST, port: process.env.KALA_PORT, sessions: process.env.KALA_SESSIONS_DIR }));
console.log(${JSON.stringify(`portable fixture ${label} ready`)});
${exits ? "process.exit(23);" : 'setInterval(() => {}, 1000);'}
`
}

function publishRelease(release, { tag, runtime = runtimeFixture(tag), manager = generatePosixPortableManager({ ...identity, tag }), omitManager = false }) {
  writeFileSync(join(release, asset), runtime)
  if (!omitManager) writeFileSync(join(release, POSIX_PORTABLE_MANAGER), manager)
  const entries = [[asset, runtime], ...(!omitManager ? [[POSIX_PORTABLE_MANAGER, manager]] : [])]
  writeFileSync(join(release, 'SHA256SUMS'), entries.map(([name, content]) => `${createHash('sha256').update(content).digest('hex')}  ${name}`).join('\n') + '\n')
  return { runtime, manager }
}

function makeHarness() {
  const scratch = mkdtempSync(join(tmpdir(), 'kala-portable-manager-'))
  const release = join(scratch, 'release')
  const fakeBin = join(scratch, 'bin')
  const root = join(scratch, 'app')
  const data = join(scratch, 'data')
  const manager = join(scratch, POSIX_PORTABLE_MANAGER)
  mkdirSync(release); mkdirSync(fakeBin); mkdirSync(data)
  const wget = `#!/usr/bin/env bash
set -eu
out=''; url=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = -O ]; then out="$2"; shift 2; continue; fi
  case "$1" in -*) shift ;; *) url="$1"; shift ;; esac
done
cp "$KALA_TEST_RELEASE/\${url##*/}" "$out"
`
  writeFileSync(join(fakeBin, 'wget'), wget); chmodSync(join(fakeBin, 'wget'), 0o755)
  writeFileSync(manager, generatePosixPortableManager(identity)); chmodSync(manager, 0o755)
  const envOutput = join(scratch, 'started.json')
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    KALA_TEST_RELEASE: release,
    KALA_RELEASE_BASE_URL: 'http://127.0.0.1:8765/releases/current',
    KALA_PORTABLE_HOME: root,
    KALA_PORTABLE_DATA_DIR: data,
    KALA_PORTABLE_TEST_ENV: envOutput,
  }
  const run = (...args) => spawnSync('bash', [manager, ...args], { env, encoding: 'utf8', timeout: 20_000 })
  const cleanup = () => {
    const pidPath = join(root, 'kala.pid')
    if (existsSync(pidPath)) {
      const match = readFileSync(pidPath, 'utf8').match(/^([1-9][0-9]*)\|/u)
      if (match) { try { process.kill(Number(match[1]), 'SIGKILL') } catch {} }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
  return { scratch, release, root, data, manager, env, envOutput, run, cleanup }
}

test('generated managers expose hardened platform-specific contracts', () => {
  const posix = generatePosixPortableManager(identity)
  const windows = generateWindowsPortableManager(identity)
  for (const command of ['install', 'start', 'status', 'logs', 'stop', 'upgrade', 'uninstall']) {
    assert.ok(posix.includes(command), `POSIX manager missing ${command}`)
    assert.ok(windows.includes(command), `Windows manager missing ${command}`)
  }
  assert.match(posix, /new URL\(input\)/u)
  assert.match(posix, /local next=latest/u)
  assert.match(posix, /verify_asset "\$base" "\$PREPARED_DIR" "\$MANAGER_ASSET"/u)
  assert.match(posix, /trap cleanup EXIT/u)
  assert.match(windows, /safe cooperative shutdown is unavailable/u)
  assert.doesNotMatch(windows, /Stop-Process\s+-/u)
  assert.match(windows, /\$quotedProgram/u)
  assert.match(windows, /Get-UrlKind/u)
  assert.match(windows, /GetPathRoot/u)
  assert.match(windows, /runtime and data directories must not overlap/u)
  assert.match(windows, /StartTimeUtcTicks/u)
  assert.match(windows, /Backup-Installation/u)
  assert.match(windows, /Restore-Installation/u)
  assert.equal(POSIX_PORTABLE_MANAGER, 'kala-portable.sh')
  assert.equal(WINDOWS_PORTABLE_MANAGER, 'kala-portable.ps1')
})

test('POSIX manager installs, starts, upgrades to latest manager, stops, and retains data', () => {
  const h = makeHarness()
  try {
    publishRelease(h.release, { tag: identity.tag })
    let result = h.run('install')
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(join(h.root, 'runtime', asset)))
    assert.ok(existsSync(join(h.root, 'bin', 'kala-portable')))

    result = h.run('start')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /127\.0\.0\.1:3000/u)
    assert.deepEqual(JSON.parse(readFileSync(h.envOutput, 'utf8')), { label: identity.tag, bind: '127.0.0.1', port: '3000', sessions: join(h.data, 'sessions') })

    result = h.run('status')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /running pid=\d+ tag=v1\.2\.3/u)

    publishRelease(h.release, { tag: 'v9.0.0' })
    result = h.run('upgrade')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /upgraded to latest/u)
    assert.match(readFileSync(join(h.root, 'bin', 'kala-portable'), 'utf8'), /BUILT_TAG='v9\.0\.0'/u)
    result = h.run('status')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /running pid=\d+ tag=latest/u)

    result = h.run('logs')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /portable fixture v9\.0\.0 ready/u)
    result = h.run('stop')
    assert.equal(result.status, 0, result.stderr)

    writeFileSync(join(h.data, 'retain-me'), 'yes')
    result = h.run('uninstall')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(h.root), false)
    assert.equal(readFileSync(join(h.data, 'retain-me'), 'utf8'), 'yes')
  } finally { h.cleanup() }
})

test('POSIX manager structurally rejects deceptive and malformed release URLs', () => {
  const h = makeHarness()
  try {
    publishRelease(h.release, { tag: identity.tag })
    const atSign = String.fromCharCode(64)
    const badUrls = [
      'http://localhost.evil.example/releases',
      `http://localhost${atSign}evil.example/releases`,
      'http://127.0.0.1.evil/releases',
      `http://127.0.0.1${atSign}evil.example/releases`,
      'http://[::1].evil/releases',
      `http://user:pass${atSign}example.com/releases`,
      'not a url',
    ]
    for (const url of badUrls) {
      const result = spawnSync('bash', [h.manager, 'install'], { env: { ...h.env, KALA_RELEASE_BASE_URL: url }, encoding: 'utf8' })
      assert.notEqual(result.status, 0, `${url} was accepted`)
      assert.match(result.stderr, /credential-free HTTPS URL/u)
    }
    for (const url of ['http://localhost:8765/path', 'http://127.0.0.1:8765/path', 'http://[::1]:8765/path']) {
      const result = spawnSync('bash', [h.manager, 'install'], { env: { ...h.env, KALA_RELEASE_BASE_URL: url }, encoding: 'utf8' })
      assert.equal(result.status, 0, `${url}: ${result.stderr}`)
    }
  } finally { h.cleanup() }
})

test('uninstall rejects filesystem roots, home directories, and overlapping runtime/data paths', () => {
  const h = makeHarness()
  try {
    const cases = [
      { KALA_PORTABLE_HOME: '/', KALA_PORTABLE_DATA_DIR: h.data },
      { HOME: h.scratch, KALA_PORTABLE_HOME: h.scratch, KALA_PORTABLE_DATA_DIR: h.data },
      { KALA_PORTABLE_HOME: join(h.scratch, 'overlap'), KALA_PORTABLE_DATA_DIR: join(h.scratch, 'overlap', 'data') },
      { KALA_PORTABLE_HOME: join(h.scratch, 'parent', 'runtime'), KALA_PORTABLE_DATA_DIR: join(h.scratch, 'parent') },
    ]
    for (const overrides of cases) {
      const result = spawnSync('bash', [h.manager, 'uninstall', '--purge-data'], { env: { ...h.env, ...overrides }, encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /unsafe Portable paths/u)
    }
    assert.ok(existsSync(h.scratch))
  } finally { h.cleanup() }
})

test('malformed or stale PID records never signal an unrelated process', () => {
  const h = makeHarness()
  try {
    publishRelease(h.release, { tag: identity.tag })
    assert.equal(h.run('install').status, 0)
    mkdirSync(h.root, { recursive: true })
    for (const record of ['-1|fake', 'abc', '0|fake', '123']) {
      writeFileSync(join(h.root, 'kala.pid'), record)
      const result = h.run('stop')
      assert.notEqual(result.status, 0, record)
      assert.match(result.stderr, /PID file is malformed/u)
    }
    writeFileSync(join(h.root, 'kala.pid'), `${process.pid}|definitely-not-this-process`)
    const result = h.run('stop')
    assert.equal(result.status, 0, result.stderr)
    process.kill(process.pid, 0)
  } finally { h.cleanup() }
})

test('upgrade verifies before stop, cleans failed staging, and leaves the running version untouched', () => {
  const h = makeHarness()
  try {
    publishRelease(h.release, { tag: identity.tag })
    assert.equal(h.run('install').status, 0)
    assert.equal(h.run('start').status, 0)
    const before = readFileSync(join(h.root, 'kala.pid'), 'utf8')
    publishRelease(h.release, { tag: 'v2.0.0', omitManager: true })
    const result = h.run('upgrade', '--tag', 'v2.0.0')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /kala-portable\.sh is absent/u)
    assert.equal(readFileSync(join(h.root, 'kala.pid'), 'utf8'), before)
    assert.equal(h.run('status').status, 0)
    assert.equal(readdirSync(h.root).some(name => name.startsWith('.upgrade.')), false)
  } finally { h.cleanup() }
})

test('failed upgraded runtime rolls back both runtime and manager and restarts the old runtime', () => {
  const h = makeHarness()
  try {
    const original = publishRelease(h.release, { tag: identity.tag })
    assert.equal(h.run('install').status, 0)
    assert.equal(h.run('start').status, 0)
    publishRelease(h.release, { tag: 'v2.0.0', runtime: runtimeFixture('v2.0.0', { exits: true }) })
    const result = h.run('upgrade', '--tag', 'v2.0.0')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /previous runtime was restored and restarted/u)
    assert.equal(readFileSync(join(h.root, 'runtime', asset), 'utf8'), original.runtime)
    assert.equal(readFileSync(join(h.root, 'bin', 'kala-portable'), 'utf8'), original.manager)
    const status = h.run('status')
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /tag=v1\.2\.3/u)
  } finally { h.cleanup() }
})

test('host release verification source requires both Portable manager assets', () => {
  const verifier = readFileSync(new URL('./verify-release-assets.mjs', import.meta.url), 'utf8')
  assert.match(verifier, /if \(includesHost\)[\s\S]*POSIX_PORTABLE_MANAGER[\s\S]*WINDOWS_PORTABLE_MANAGER/u)
  assert.match(verifier, /manifest missing Portable manager asset/u)
})

test('manager generators reject unsafe release identities', () => {
  assert.throws(() => generatePosixPortableManager({ repo: 'bad repo', tag: 'v1' }), /repo/u)
  assert.throws(() => generateWindowsPortableManager({ repo: 'example/kala', tag: 'v1;oops' }), /tag/u)
})
