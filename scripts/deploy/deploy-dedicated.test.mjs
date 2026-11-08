import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./deploy-dedicated.mjs', import.meta.url))
const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    makeTreeRemovable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

function makeTreeRemovable(path) {
  try {
    const value = statSync(path)
    if (!value.isDirectory()) return
    chmodSync(path, 0o700)
    for (const name of readdirSync(path)) makeTreeRemovable(join(path, name))
  } catch {}
}

describe('deploy:dedicated client', () => {
  it('exposes one explicit slot-topology command surface', () => {
    const output = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
    const pnpmStyleOutput = execFileSync(process.execPath, [script, '--', '--help'], { encoding: 'utf8' })
    for (const command of ['stage', 'status', 'wait', 'inspect', 'abort', 'rollback']) expect(output).toContain(command)
    expect(pnpmStyleOutput).toBe(output)
    expect(output).toContain('--local')
    expect(output).toContain('--lxd')
    expect(output).toContain('--ssh')
    expect(output).toContain('--local-development')
    expect(output).toContain('never invokes the legacy single-service')
  })

  it('rejects local-development over SSH, with a custom release, or from a packaged CLI', () => {
    expectFailure([script, 'stage', '--local-development', '--ssh', 'deployer@example'], 'does not support SSH')
    expectFailure([script, 'stage', '--local-development', '--local', '--release-dir', '/tmp/release'], 'always derives from the repository release/')

    const root = mkdtempSync(join(tmpdir(), 'deploy-dedicated-packaged-local-dev-')); roots.push(root)
    const packagedScript = join(root, 'deploy-dedicated.mjs')
    copyFileSync(script, packagedScript)
    expectFailure([packagedScript, 'stage', '--local-development', '--local', '--skip-build'], 'only from a source repository checkout')
  })

  it('rejects ambiguous transport selection', () => {
    expectFailure([script, 'stage', '--local', '--lxd', 'candidate', '--skip-build'], 'choose exactly one transport')
  })

  it('stages an unsigned local-development release without changing release/', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-dedicated-local-dev-')); roots.push(root)
    const deployRoot = createDeployRoot(root)
    const sourceCheckout = createSourceCheckout(root)
    const sourceRelease = sourceCheckout.release
    const originalManifest = readFileSync(join(sourceRelease, 'manifest.json'))
    const originalEntries = readdirSync(sourceRelease).sort()
    const tempBefore = localDevelopmentTempDirectories()
    execFileSync(process.execPath, [sourceCheckout.script, 'stage', '--local-development', '--local', '--skip-build', '--deploy-root', deployRoot, '--operation-id', 'operation-local-dev-0001', '--deployment-id', 'deployment-local-dev-0001'], { encoding: 'utf8' })

    const staged = join(deployRoot, 'submissions', 'operation-local-dev-0001')
    const manifest = JSON.parse(readFileSync(join(staged, 'manifest.json'), 'utf8'))
    expect(manifest.localDevelopment).toBe(true)
    expect([...manifest.assets].sort()).toEqual([...localDevelopmentAssets].sort())
    expect(readdirSync(staged).sort()).toEqual([...localDevelopmentAssets, 'manifest.json', 'SHA256SUMS'].sort())
    expect(exists(staged, 'SHA256SUMS.sigstore.json')).toBe(false)
    expect(readFileSync(join(sourceRelease, 'manifest.json'))).toEqual(originalManifest)
    expect(readdirSync(sourceRelease).sort()).toEqual(originalEntries)
    expect(localDevelopmentTempDirectories()).toEqual(tempBefore)
  }, 120_000)

  it('cleans the derived release when immutable staging fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-dedicated-local-dev-failure-')); roots.push(root)
    const sourceCheckout = createSourceCheckout(root)
    const tempBefore = localDevelopmentTempDirectories()
    expectFailure([sourceCheckout.script, 'stage', '--local-development', '--local', '--skip-build', '--deploy-root', join(root, 'missing')], 'ENOENT')
    expect(localDevelopmentTempDirectories()).toEqual(tempBefore)
  }, 120_000)

  it('reads authoritative receipts by deployment or operation id without mutating state', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-dedicated-status-')); roots.push(root)
    mkdirSync(join(root, 'receipts'), { recursive: true })
    const receipt = { schemaVersion: 1, receiptRevision: 4, deploymentId: 'deployment-test-0001', operationId: 'operation-test-0001', operationIds: ['operation-test-0001'], phase: 'waiting_for_boundary', updatedAt: new Date().toISOString(), releaseDir: '/private/path' }
    writeFileSync(join(root, 'receipts', receipt.deploymentId + '.json'), JSON.stringify(receipt))
    writeFileSync(join(root, 'operation-index.json'), JSON.stringify({ [receipt.operationId]: receipt.deploymentId }))
    const direct = JSON.parse(execFileSync(process.execPath, [script, 'status', receipt.deploymentId, '--local', '--deploy-root', root], { encoding: 'utf8' }))
    const indexed = JSON.parse(execFileSync(process.execPath, [script, 'status', receipt.operationId, '--local', '--deploy-root', root], { encoding: 'utf8' }))
    expect(direct.receiptRevision).toBe(4)
    expect(indexed.deploymentId).toBe(receipt.deploymentId)
    expect(direct.releaseDir).toBeUndefined()
  })

  it('preserves each SSH bash script as one remote -lc argument', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-dedicated-ssh-')); roots.push(root)
    const bin = join(root, 'bin')
    const deployRoot = join(root, 'deploy')
    mkdirSync(bin, { recursive: true })
    mkdirSync(join(deployRoot, 'receipts'), { recursive: true })
    const receipt = {
      schemaVersion: 1, receiptRevision: 7, deploymentId: 'deployment-ssh-0001',
      operationId: 'operation-ssh-0001', operationIds: ['operation-ssh-0001'],
      phase: 'waiting_for_boundary', updatedAt: new Date().toISOString(),
    }
    writeFileSync(join(deployRoot, 'receipts', receipt.deploymentId + '.json'), JSON.stringify(receipt))
    const fakeSsh = join(bin, 'ssh')
    writeFileSync(fakeSsh, [
      '#!/usr/bin/env node',
      "const { spawnSync } = require('node:child_process')",
      "const fs = require('node:fs')",
      "const remoteCommand = process.argv.slice(3).join(' ')",
      "const result = spawnSync('/bin/sh', ['-c', remoteCommand], { input: fs.readFileSync(0) })",
      "process.stdout.write(result.stdout ?? '')",
      "process.stderr.write(result.stderr ?? '')",
      "process.exit(result.status ?? 1)",
      '',
    ].join('\n'))
    chmodSync(fakeSsh, 0o755)

    const output = JSON.parse(execFileSync(process.execPath, [
      script, 'status', receipt.deploymentId, '--ssh', 'deployer@example', '--deploy-root', deployRoot,
    ], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }))
    expect(output).toMatchObject({ deploymentId: receipt.deploymentId, receiptRevision: 7 })
  })

  it('contains durable submission and transport adapters without legacy restart calls', async () => {
    const source = await import('node:fs/promises').then((fs) => fs.readFile(script, 'utf8'))
    expect(source).toContain('fsyncSync(file)')
    expect(source).toContain('fsyncSync(directory)')
    expect(source).toContain('commandTransport')
    expect(source).toContain('runCommand')
    expect(source).toContain('runSourceCommand')
    expect(source).toContain("'lxd'")
    expect(source).toContain("'ssh'")
    expect(source).not.toContain('/runtime/restart')
    expect(source).not.toContain('deploy-finalize.mjs')
  })

  it('automatically binds self-deployment origin identity from Executor environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-dedicated-origin-env-')); roots.push(root)
    const releaseDir = join(root, 'release')
    const deployRoot = join(root, 'deploy')
    const predecessorDir = join(deployRoot, 'releases', 'predecessor')
    mkdirSync(releaseDir, { recursive: true })
    mkdirSync(predecessorDir, { recursive: true })
    mkdirSync(join(deployRoot, 'requests'), { recursive: true })
    mkdirSync(join(deployRoot, 'submissions'), { recursive: true })
    const assets = ['kala-runtime.cjs', 'kala-dedicated-support.tar.gz']
    writeFileSync(join(releaseDir, 'kala-runtime.cjs'), '#!/usr/bin/env node\nprocess.exit(0)\n')
    createSupportBundle(releaseDir, false)
    writeFileSync(join(releaseDir, 'manifest.json'), JSON.stringify({ assets }))
    writeSums(releaseDir, [...assets, 'manifest.json'])
    writeFileSync(join(predecessorDir, 'SHA256SUMS'), `${'a'.repeat(64)}  predecessor\n`)
    writeFileSync(join(deployRoot, 'route-state.json'), JSON.stringify({ schemaVersion: 1, generation: 3, activeSlot: 'blue', slots: { blue: { origin: 'http://127.0.0.1:13001', releaseId: 'predecessor' }, green: { origin: 'http://127.0.0.1:13002', releaseId: 'predecessor' } } }))
    const output = JSON.parse(execFileSync(process.execPath, [script, '--', 'stage', '--local', '--skip-build', '--release-dir', releaseDir, '--deploy-root', deployRoot, '--release-id', 'candidate', '--operation-id', 'operation-origin-0001', '--deployment-id', 'deployment-origin-0001'], { encoding: 'utf8', env: { ...process.env, KALA_SESSION_ID: 'session-origin-0001', KALA_CALL_ID: 'call-origin-0001' } }))
    expect(output).toMatchObject({ accepted: true, operationId: 'operation-origin-0001', deploymentId: 'deployment-origin-0001' })
    const request = JSON.parse(readFileSync(join(deployRoot, 'requests', 'operation-origin-0001.json'), 'utf8'))
    expect(request.origin).toEqual({ sessionId: 'session-origin-0001', callId: 'call-origin-0001' })
    expect(request.stagedReleaseDir).toBe(join(deployRoot, 'submissions', request.operationId))
    expect(readdirSync(request.stagedReleaseDir).sort()).toEqual([...assets, 'manifest.json', 'SHA256SUMS'].sort())
    expect(exists(request.stagedReleaseDir, 'deployment.json')).toBe(false)
    expect(exists(request.stagedReleaseDir, 'RELEASE_NOTES.md')).toBe(false)
    expect(request.releaseDir).toBeUndefined()
  })

  it('runs from the immutable release directory without assuming a source checkout layout', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-dedicated-packaged-')); roots.push(root)
    const packaged = join(root, 'release')
    const deployRoot = join(root, 'deploy')
    const predecessorDir = join(deployRoot, 'releases', 'predecessor')
    mkdirSync(packaged, { recursive: true })
    mkdirSync(predecessorDir, { recursive: true })
    mkdirSync(join(deployRoot, 'requests'), { recursive: true })
    mkdirSync(join(deployRoot, 'submissions'), { recursive: true })
    copyFileSync(script, join(packaged, 'deploy-dedicated.mjs'))
    writeFileSync(join(packaged, 'kala-runtime.cjs'), '#!/usr/bin/env node\nprocess.exit(0)\n')
    createSupportBundle(packaged, true)
    const assets = ['kala-runtime.cjs', 'kala-dedicated-support.tar.gz']
    writeFileSync(join(packaged, 'manifest.json'), JSON.stringify({ assets }))
    writeSums(packaged, [...assets, 'manifest.json'])
    writeFileSync(join(predecessorDir, 'SHA256SUMS'), `${'a'.repeat(64)}  predecessor\n`)
    writeFileSync(join(deployRoot, 'route-state.json'), JSON.stringify({ schemaVersion: 1, generation: 9, activeSlot: 'green', slots: { blue: { origin: 'http://127.0.0.1:13001', releaseId: 'predecessor' }, green: { origin: 'http://127.0.0.1:13002', releaseId: 'predecessor' } } }))

    const output = JSON.parse(execFileSync(process.execPath, [join(packaged, 'deploy-dedicated.mjs'), 'stage', '--local', '--skip-build', '--deploy-root', deployRoot, '--release-id', 'packaged-candidate', '--operation-id', 'operation-packaged-0001', '--deployment-id', 'deployment-packaged-0001'], { encoding: 'utf8' }))
    expect(output).toMatchObject({ accepted: true, operationId: 'operation-packaged-0001', expectedRouteGeneration: 9 })
    const request = JSON.parse(readFileSync(join(deployRoot, 'requests', 'operation-packaged-0001.json'), 'utf8'))
    expect(request).toMatchObject({
      releaseId: 'packaged-candidate',
      stagedReleaseDir: join(deployRoot, 'submissions', 'operation-packaged-0001'),
    })
    expect(readdirSync(request.stagedReleaseDir).sort()).toEqual([...assets, 'manifest.json', 'SHA256SUMS'].sort())
    for (const supportAsset of supportAssets) expect(exists(request.stagedReleaseDir, supportAsset)).toBe(false)
  })
})

const localDevelopmentAssets = ['kala-dashboard-with-runtime.cjs', 'kala-runtime.cjs', 'kala-executor.cjs', 'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs', 'kala-dashboard.tar.gz', 'kala-docs.tar.gz', 'kala-dedicated-support.tar.gz', 'kala-model-catalog-seed.json', 'run.sh', 'kala-dedicated.mjs', 'kala-release-metadata.tar.gz']
const supportAssets = ['cutover-dedicated-systemd.mjs', 'dedicated-data-migration.mjs', 'dedicated-settings-fingerprint.mjs', 'deploy-dashboard.mjs', 'deploy-dedicated.mjs', 'deployment.json', 'install-dedicated-systemd.mjs', 'kala-dedicated-control-updater.service', 'kala-dedicated-deploy-supervisor.service', 'kala-dedicated-ingress.service', 'kala-dedicated-migration-finalizer.service', 'kala-dedicated-unit@.service', 'rollback-dedicated-systemd.mjs', 'update-dedicated-control-plane.mjs']

function createSourceCheckout(root) {
  const checkout = join(root, 'checkout')
  const fixtureScript = join(checkout, 'scripts', 'deploy', 'deploy-dedicated.mjs')
  const verifier = join(checkout, 'scripts', 'release', 'verify-release-assets.mjs')
  const release = join(checkout, 'release')
  mkdirSync(join(checkout, 'scripts', 'deploy'), { recursive: true })
  mkdirSync(join(checkout, 'scripts', 'release'), { recursive: true })
  mkdirSync(release, { recursive: true })
  copyFileSync(script, fixtureScript)
  writeFileSync(verifier, '')
  for (const asset of localDevelopmentAssets) {
    if (asset !== 'kala-dedicated-support.tar.gz') writeFileSync(join(release, asset), `${asset}\n`)
  }
  createSupportBundle(release, false)
  writeFileSync(join(release, 'manifest.json'), JSON.stringify({ assets: localDevelopmentAssets }))
  writeSums(release, [...localDevelopmentAssets, 'manifest.json'])
  return { script: fixtureScript, release }
}

function digest(path) { return execFileSync('sha256sum', [path], { encoding: 'utf8' }).split(' ')[0] }
function writeSums(root, names) { writeFileSync(join(root, 'SHA256SUMS'), names.sort().map((name) => `${digest(join(root, name))}  ${name}`).join('\n') + '\n') }
function createSupportBundle(root, expanded) {
  for (const name of supportAssets) if (!exists(root, name)) writeFileSync(join(root, name), `${name}\n`)
  const entries = supportAssets.map((name) => { const bytes = readFileSync(join(root, name)); return { name, bytes: bytes.length, sha256: digest(join(root, name)) } })
  writeFileSync(join(root, 'dedicated-support-manifest.json'), `${JSON.stringify({ schemaVersion: 1, product: 'kala-dedicated-support', assets: entries }, null, 2)}\n`)
  execFileSync('tar', ['-czf', join(root, 'kala-dedicated-support.tar.gz'), '-C', root, ...supportAssets, 'dedicated-support-manifest.json'])
  rmSync(join(root, 'dedicated-support-manifest.json'))
  if (!expanded) for (const name of supportAssets) rmSync(join(root, name))
}
function exists(root, name) { try { statSync(join(root, name)); return true } catch { return false } }
function expectFailure(args, message) {
  try {
    execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' })
    throw new Error('command unexpectedly succeeded')
  } catch (error) {
    expect(String(error.stderr ?? error.message)).toContain(message)
  }
}
function createDeployRoot(root) {
  const deployRoot = join(root, 'deploy')
  mkdirSync(join(deployRoot, 'releases', 'predecessor'), { recursive: true })
  mkdirSync(join(deployRoot, 'requests'), { recursive: true })
  mkdirSync(join(deployRoot, 'submissions'), { recursive: true })
  writeFileSync(join(deployRoot, 'releases', 'predecessor', 'SHA256SUMS'), `${'a'.repeat(64)}  predecessor\n`)
  writeFileSync(join(deployRoot, 'route-state.json'), JSON.stringify({ schemaVersion: 1, generation: 1, activeSlot: 'blue', slots: { blue: { origin: 'http://127.0.0.1:13001', releaseId: 'predecessor' }, green: { origin: 'http://127.0.0.1:13002', releaseId: 'predecessor' } } }))
  return deployRoot
}
function localDevelopmentTempDirectories() { return readdirSync(tmpdir()).filter((name) => name.startsWith('kala-local-development-release-')).sort() }
