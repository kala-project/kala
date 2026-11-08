import assert from 'node:assert/strict'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { assertLocalDedicatedVerification, executorProtocolMajor, signExecutorUpdateFeed, UPDATE_FEED_FILES, verifyExecutorUpdateFeed } from './executor-update-feed.mjs'
import { stageSignedExecutorUpdateFeed } from './stage-signed-executor-update-feed.mjs'
import { verifyReleaseChecksums } from './release-checksums.mjs'

function fixture() {
  const directory = join(import.meta.dirname, `.executor-update-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(directory)
  const { privateKey } = generateKeyPairSync('ed25519')
  const keyFile = join(directory, 'operator.pem')
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const manifest = { version: '0.3.1', tag: 'v0.3.1', repo: 'example/kala', component: 'all', assets: ['kala-executor.cjs'] }
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  for (const name of ['kala-executor.cjs', 'node-pty-win32-x64.tar.gz', 'kala-executor-service-host-win32-x64.exe']) {
    writeFileSync(join(directory, name), `release artifact ${name}`)
  }
  return { directory, keyFile, privateKey }
}

test('signs the precise CJS update artifact with a persistent Ed25519 PEM key', () => {
  const { directory, keyFile } = fixture()
  try {
    assert.equal(verifyExecutorUpdateFeed(directory, executorProtocolMajor()), false)
    assert.throws(() => verifyExecutorUpdateFeed(directory, executorProtocolMajor(), { required: true }), /both Executor update feed files/u)
    signExecutorUpdateFeed(directory, keyFile, executorProtocolMajor())
    assert.equal(verifyExecutorUpdateFeed(directory, executorProtocolMajor(), { required: true }), true)
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.assets.slice(-2), UPDATE_FEED_FILES)
    const envelope = JSON.parse(readFileSync(join(directory, UPDATE_FEED_FILES[0]), 'utf8'))
    assert.equal(JSON.parse(envelope.signed).artifact.file, 'kala-executor')
    assert.equal(JSON.parse(envelope.signed).artifact.url, './kala-executor.cjs')
    assert.throws(() => signExecutorUpdateFeed(directory, keyFile, executorProtocolMajor()), /already listed/u)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('rejects missing, tampered, and semantically incorrect signed feeds', () => {
  const { directory, keyFile, privateKey } = fixture()
  try {
    signExecutorUpdateFeed(directory, keyFile, executorProtocolMajor())
    const path = join(directory, UPDATE_FEED_FILES[0])
    const original = readFileSync(path)
    writeFileSync(path, `${original.toString('utf8')} `)
    const envelope = JSON.parse(readFileSync(path, 'utf8'))
    envelope.signature = envelope.signature.replace(/^./u, envelope.signature[0] === 'A' ? 'B' : 'A')
    writeFileSync(path, JSON.stringify(envelope))
    assert.throws(() => verifyExecutorUpdateFeed(directory, executorProtocolMajor(), { required: true }), /signature/u)
    const malformed = JSON.parse(original)
    const payload = JSON.parse(malformed.signed)
    payload.artifact.url = './wrong.cjs'
    malformed.signed = JSON.stringify(payload)
    malformed.signature = sign(null, Buffer.from(malformed.signed), privateKey).toString('base64')
    writeFileSync(path, JSON.stringify(malformed))
    assert.throws(() => verifyExecutorUpdateFeed(directory, executorProtocolMajor(), { required: true }), /does not match/u)
    writeFileSync(path, original)
    writeFileSync(join(directory, 'kala-executor.cjs'), 'changed')
    assert.throws(() => verifyExecutorUpdateFeed(directory, executorProtocolMajor(), { required: true }), /does not match/u)
    rmSync(join(directory, UPDATE_FEED_FILES[1]))
    assert.throws(() => verifyExecutorUpdateFeed(directory, executorProtocolMajor(), { required: true }))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('stages an offline-signed feed only for the exact tag, revision, artifact, and operator key', () => {
  const { directory, keyFile, privateKey } = fixture()
  const revision = 'a'.repeat(40)
  try {
    const unsigned = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
    unsigned.source = { revision, dirty: false }
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(unsigned))
    signExecutorUpdateFeed(directory, keyFile, executorProtocolMajor())
    const envelope = readFileSync(join(directory, UPDATE_FEED_FILES[0]))
    const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
    rmSync(join(directory, UPDATE_FEED_FILES[0]))
    rmSync(join(directory, UPDATE_FEED_FILES[1]))
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(unsigned))
    const tagObject = `object ${revision}\ntype commit\ntag v0.3.1\ntagger Operator <operator@example.test> 0 +0000\n\nKala release candidate\nExecutor-Update-Manifest-Base64: ${envelope.toString('base64')}\n`
    const stage = (object = tagObject, key = publicKey) =>
      stageSignedExecutorUpdateFeed(directory, 'v0.3.1', revision, object, key, executorProtocolMajor())
    assert.throws(() => stage(tagObject.replace(revision, 'b'.repeat(40))), /exact release commit/u)
    assert.throws(() => stage(tagObject.replace('Kala release candidate', 'Unverified candidate')), /offline-signed/u)
    const alternateKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })
    assert.throws(() => stage(tagObject, alternateKey), /signature verification/u)
    rmSync(join(directory, UPDATE_FEED_FILES[0]))
    rmSync(join(directory, UPDATE_FEED_FILES[1]))
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(unsigned))
    stage()
    assert.equal(verifyExecutorUpdateFeed(directory, executorProtocolMajor(), { required: true }), true)
    writeFileSync(join(directory, 'kala-executor.cjs'), 'changed')
    assert.throws(() => verifyExecutorUpdateFeed(directory, executorProtocolMajor(), { required: true }), /does not match/u)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('local Dedicated CLI signs a verified Linux-only CJS stage without embedding Host assets', async () => {
  const { directory, keyFile } = fixture()
  const operatorKey = `${directory}.operator.pem`
  try {
    writeFileSync(operatorKey, readFileSync(keyFile))
    rmSync(keyFile)
    for (const name of ['node-pty-win32-x64.tar.gz', 'kala-executor-service-host-win32-x64.exe']) {
      rmSync(join(directory, name))
    }
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
    manifest.nativeTargets = []
    manifest.assets.push(
      'kala-dashboard-with-runtime.cjs', 'kala-runtime.cjs',
      'kala-dedicated-ingress.cjs', 'kala-dedicated-deploy-supervisor.cjs',
    )
    for (const name of manifest.assets.filter((name) => name !== 'kala-executor.cjs')) {
      writeFileSync(join(directory, name), `Linux CJS stage ${name}`)
    }
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
    const digest = (name) => createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')
    const checksumFiles = [...manifest.assets, 'manifest.json']
    const index = () => checksumFiles.map((name) => `${digest(name)}  ${name}`).join('\n') + '\n'
    writeFileSync(join(directory, 'SHA256SUMS'), index())

    const cli = join(import.meta.dirname, 'sign-executor-update-feed.mjs')
    const run = (...flags) => spawnSync(process.execPath, [cli, '--directory', directory, '--private-key-file', operatorKey, ...flags], { encoding: 'utf8' })
    assert.notEqual(run().status, 0, 'public signing must reject a Linux-only stage')
    writeFileSync(join(directory, 'node-pty-win32-x64.tar.gz'), 'unexpected Windows payload')
    assert.notEqual(run('--local-dedicated').status, 0, 'local signing must reject Windows assets')
    rmSync(join(directory, 'node-pty-win32-x64.tar.gz'))
    writeFileSync(join(directory, 'kala-executor.cjs'), 'unverified')
    assert.notEqual(run('--local-dedicated').status, 0, 'local signing must reject a changed artifact')
    writeFileSync(join(directory, 'kala-executor.cjs'), 'release artifact kala-executor.cjs')
    assert.equal(run('--local-dedicated').status, 0)
    assert.equal(verifyExecutorUpdateFeed(directory, executorProtocolMajor(), { required: true }), true)
    await verifyReleaseChecksums(directory, [...manifest.assets, ...UPDATE_FEED_FILES, 'manifest.json'])
    assert.equal(readFileSync(join(directory, 'kala-dashboard-with-runtime.cjs'), 'utf8'), 'Linux CJS stage kala-dashboard-with-runtime.cjs')

    const signedManifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
    const localMode = {
      enabled: true, privateCloudRuntime: false, requireSigned: false,
      manifest: signedManifest, hasUpdateFeed: true, hasWindowsPayload: false, signaturePresent: false,
    }
    assert.doesNotThrow(() => assertLocalDedicatedVerification(localMode))
    for (const change of [
      { hasUpdateFeed: false },
      { hasWindowsPayload: true },
      { signaturePresent: true },
      { requireSigned: true },
      { privateCloudRuntime: true },
      { manifest: { ...signedManifest, nativeTargets: ['linux-x64'] } },
      { manifest: { ...signedManifest, component: 'host' } },
    ]) {
      assert.throws(() => assertLocalDedicatedVerification({ ...localMode, ...change }), /local Dedicated verification/u)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
    rmSync(operatorKey, { force: true })
  }
})
