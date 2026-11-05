import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  packageWindowsNodePtyCompanion,
  WINDOWS_EXECUTOR_TARGET,
  WINDOWS_NODE_PTY_BINARY_FILES,
  WINDOWS_NODE_PTY_JS_FILES,
} from '../release/windows-executor-packager.mjs'

const script = fileURLToPath(new URL('./prepare-windows-release-fixture.mjs', import.meta.url))
const sha = (value) => createHash('sha256').update(value).digest('hex')
const serviceHostFixture = process.env.KALA_TEST_WINSW_PATH || '/tmp/kala-winsw-v2.12.0-x64.exe'

function stageServiceHostFixture(executor, t) {
  if (!existsSync(serviceHostFixture)) {
    t.skip('official WinSW fixture is not present')
    return false
  }
  copyFileSync(serviceHostFixture, join(executor, 'kala-executor-service-host-win32-x64.exe'))
  return true
}

function fakeWindowsX64Pe(marker) {
  const bytes = Buffer.alloc(128)
  bytes.write('MZ')
  bytes.writeUInt32LE(0x40, 0x3c)
  bytes.write('PE\0\0', 0x40, 'binary')
  bytes.writeUInt16LE(0x8664, 0x44)
  bytes[0x46] = marker
  return bytes
}

function stageCompanionFixture(root, executor) {
  const nodePty = join(root, 'node-pty')
  mkdirSync(join(nodePty, 'prebuilds', WINDOWS_EXECUTOR_TARGET), { recursive: true })
  writeFileSync(join(nodePty, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }))
  for (const [index, name] of WINDOWS_NODE_PTY_BINARY_FILES.entries()) {
    const source = join(nodePty, 'prebuilds', WINDOWS_EXECUTOR_TARGET, name)
    writeFileSync(source, fakeWindowsX64Pe(index))
    const destination = join(executor, 'prebuilds', WINDOWS_EXECUTOR_TARGET, name)
    mkdirSync(join(destination, '..'), { recursive: true })
    copyFileSync(source, destination)
  }
  for (const relative of WINDOWS_NODE_PTY_JS_FILES) {
    const source = join(nodePty, 'lib', ...relative.split('/'))
    const destination = join(executor, ...relative.split('/'))
    mkdirSync(join(source, '..'), { recursive: true })
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(source, `module.exports = ${JSON.stringify(relative)}\n`)
    copyFileSync(source, destination)
  }
  packageWindowsNodePtyCompanion({ nodePtyRoot: nodePty, outputPath: join(executor, 'node-pty-win32-x64.tar.gz') })
}

test('source-built Windows fixture stages matching Host-served assets without claiming release signature', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kala-win-fixture-'))
  const host = join(dir, 'host')
  const executor = join(dir, 'executor')
  try {
    mkdirSync(host); mkdirSync(executor)
    writeFileSync(join(host, 'kala-dashboard-with-runtime.cjs'), 'host')
    writeFileSync(join(host, 'kala-executor.cjs'), 'executor')
    writeFileSync(join(host, 'SHA256SUMS'), `${sha('host')}  kala-dashboard-with-runtime.cjs\n${sha('executor')}  kala-executor.cjs\n`)
    writeFileSync(join(executor, 'kala-executor.cjs'), 'executor')
    if (!stageServiceHostFixture(executor, t)) return
    stageCompanionFixture(dir, executor)
    const args = [script, '--host-release', host, '--executor-release', executor]
    writeFileSync(join(executor, 'kala-executor.cjs'), 'different')
    const mismatch = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(mismatch.status, 0)
    assert.match(mismatch.stderr, /Executor CJS differs from the Host build/u)
    writeFileSync(join(executor, 'kala-executor.cjs'), 'executor')
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.equal(first.status, 0, first.stderr)
    assert.match(first.stdout, /local source-build checksums only; not signed release evidence/u)
    const entries = readFileSync(join(host, 'SHA256SUMS'), 'utf8').trim().split('\n')
    assert.equal(entries.length, 5)
    for (const line of entries) {
      const [, digest, name] = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u) ?? []
      assert.ok(name)
      assert.equal(sha(readFileSync(join(host, name))), digest)
    }
    assert.match(readFileSync(join(host, 'install-executor.ps1'), 'utf8'), /worker\/conoutSocketWorker\.js/u)
    assert.match(readFileSync(join(host, 'install-executor.ps1'), 'utf8'), /kala-executor-service-host-win32-x64\.exe/u)
    assert.match(readFileSync(join(host, 'install-executor.ps1'), 'utf8'), /shared\/conout\.js/u)
    const duplicate = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(duplicate.status, 0)
    assert.match(duplicate.stderr, /preexisting Windows checksum entry/u)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('source-built Windows fixture rejects an extracted payload missing the worker', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kala-win-fixture-missing-worker-'))
  const host = join(dir, 'host')
  const executor = join(dir, 'executor')
  try {
    mkdirSync(host); mkdirSync(executor)
    writeFileSync(join(host, 'kala-dashboard-with-runtime.cjs'), 'host')
    writeFileSync(join(host, 'kala-executor.cjs'), 'executor')
    writeFileSync(join(host, 'SHA256SUMS'), `${sha('host')}  kala-dashboard-with-runtime.cjs\n${sha('executor')}  kala-executor.cjs\n`)
    writeFileSync(join(executor, 'kala-executor.cjs'), 'executor')
    if (!stageServiceHostFixture(executor, t)) return
    stageCompanionFixture(dir, executor)
    rmSync(join(executor, 'worker', 'conoutSocketWorker.js'))
    const result = spawnSync(process.execPath, [script, '--host-release', host, '--executor-release', executor], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /missing worker\/conoutSocketWorker\.js/u)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
