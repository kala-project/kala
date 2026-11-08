import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const UPDATE_MANIFEST = 'executor-update-manifest.json'
export const UPDATE_PUBLIC_KEY = 'executor-update-public-key.pem'
export const UPDATE_FEED_FILES = [UPDATE_MANIFEST, UPDATE_PUBLIC_KEY]
export const UPDATE_ARTIFACT = 'kala-executor.cjs'
const LINUX_STAGE_ASSETS = [
  'kala-dashboard-with-runtime.cjs',
  'kala-runtime.cjs',
  UPDATE_ARTIFACT,
  'kala-dedicated-ingress.cjs',
  'kala-dedicated-deploy-supervisor.cjs',
]

export function executorProtocolMajor() {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const source = readFileSync(join(root, 'packages/shared/src/protocol.ts'), 'utf8')
  const match = source.match(/^export const PROTOCOL_VERSION = '(\d+)\.\d+\.\d+' as const$/mu)
  if (!match) throw new Error('shared protocol version is unavailable')
  return Number(match[1])
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function releaseIdentity(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  if (!/^[^/\s]+\/[^/\s]+$/u.test(manifest.repo)
    || !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.tag)
    || manifest.tag.slice(1) !== manifest.version
    || !manifest.assets?.includes(UPDATE_ARTIFACT)) {
    throw new Error('Executor update feed requires a matching release tag, version, repo, and CJS Executor')
  }
  return manifest
}

function verifyLinuxStage(directory, manifest) {
  if (process.platform !== 'linux' || process.arch !== 'x64'
    || manifest.component !== 'all'
    || JSON.stringify(manifest.nativeTargets) !== '[]'
    || !LINUX_STAGE_ASSETS.every((name) => manifest.assets.includes(name))
    || manifest.assets.some((name) => /(?:win32|windows)/iu.test(name))
    || readdirSync(directory).some((name) => /(?:win32|windows|sigstore)/iu.test(name))) {
    throw new Error('local Dedicated signing requires a complete unsigned Linux x64 all-component CJS stage without Windows assets')
  }
  const expectedFiles = [...manifest.assets, 'manifest.json']
  if (new Set(expectedFiles).size !== expectedFiles.length
    || JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify([...expectedFiles, 'SHA256SUMS'].sort())) {
    throw new Error('local Dedicated stage file inventory is not closed')
  }
  const checksums = readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trimEnd().split(/\r?\n/u)
  if (checksums.length !== expectedFiles.length) throw new Error('local Dedicated stage checksum index is incomplete')
  const remaining = new Set(expectedFiles)
  for (const line of checksums) {
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._@-]*)$/u)
    if (!match || !remaining.delete(match[2]) || !lstatSync(join(directory, match[2])).isFile()
      || digest(readFileSync(join(directory, match[2]))) !== match[1]) {
      throw new Error('local Dedicated stage checksum verification failed')
    }
  }
}

export function signExecutorUpdateFeed(directory, privateKeyFile, protocol, { localDedicated = false } = {}) {
  if (!Number.isSafeInteger(protocol) || protocol < 0) throw new Error('Executor update protocol must be a nonnegative integer')
  const manifest = releaseIdentity(directory)
  if (localDedicated) {
    verifyLinuxStage(directory, manifest)
  } else if (manifest.component !== 'all'
    || !['node-pty-win32-x64.tar.gz', 'kala-executor-service-host-win32-x64.exe'].every((name) => statSync(join(directory, name)).isFile())) {
    throw new Error('Executor update feed signing requires the staged final release with Windows installer payloads')
  }
  if (UPDATE_FEED_FILES.some((name) => manifest.assets.includes(name))) {
    throw new Error('Executor update feed is already listed in the release manifest')
  }
  const key = createPrivateKey(readFileSync(privateKeyFile))
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Executor update signing key must be Ed25519')
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' })
  const artifact = readFileSync(join(directory, UPDATE_ARTIFACT))
  if (!artifact.length) throw new Error('Executor update artifact must not be empty')
  const signed = JSON.stringify({
    version: 1,
    release: manifest.version,
    channel: 'stable',
    protocol: { min: protocol, max: protocol },
    artifact: { url: `./${UPDATE_ARTIFACT}`, size: artifact.length, sha256: digest(artifact), file: 'kala-executor' },
  })
  writeFileSync(join(directory, UPDATE_MANIFEST), `${JSON.stringify({ signed, signature: sign(null, Buffer.from(signed), key).toString('base64') })}\n`)
  writeFileSync(join(directory, UPDATE_PUBLIC_KEY), publicKey)
  manifest.assets.push(...UPDATE_FEED_FILES)
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (localDedicated) {
    const entries = [...manifest.assets, 'manifest.json']
      .map((name) => `${digest(readFileSync(join(directory, name)))}  ${name}`)
    writeFileSync(join(directory, 'SHA256SUMS'), `${entries.join('\n')}\n`)
  }
}

export function verifyExecutorUpdateFeed(directory, protocol, { required = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  const present = UPDATE_FEED_FILES.map((name) => manifest.assets.includes(name))
  if (present.some(Boolean) !== present.every(Boolean) || (required && !present.every(Boolean))) {
    throw new Error('release manifest must list both Executor update feed files')
  }
  if (!present.every(Boolean)) return false
  releaseIdentity(directory)
  const envelope = JSON.parse(readFileSync(join(directory, UPDATE_MANIFEST), 'utf8'))
  const keyBytes = readFileSync(join(directory, UPDATE_PUBLIC_KEY))
  const key = createPublicKey(keyBytes)
  if (key.asymmetricKeyType !== 'ed25519'
    || key.export({ type: 'spki', format: 'pem' }) !== keyBytes.toString('utf8')) {
    throw new Error('Executor update verification key must be canonical Ed25519 PEM')
  }
  if (typeof envelope.signed !== 'string'
    || typeof envelope.signature !== 'string'
    || !/^[A-Za-z0-9+/]{86}==$/u.test(envelope.signature)
    || !verify(null, Buffer.from(envelope.signed), key, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('Executor update feed signature verification failed')
  }
  const feed = JSON.parse(envelope.signed)
  const artifactPath = join(directory, UPDATE_ARTIFACT)
  const artifact = readFileSync(artifactPath)
  if (feed.version !== 1 || feed.release !== manifest.version || feed.channel !== 'stable'
    || !Number.isSafeInteger(protocol) || protocol < 0
    || JSON.stringify(feed.protocol) !== JSON.stringify({ min: protocol, max: protocol })
    || feed.artifact?.url !== `./${UPDATE_ARTIFACT}`
    || feed.artifact?.file !== 'kala-executor'
    || feed.artifact?.size !== artifact.length || !artifact.length
    || feed.artifact?.sha256 !== digest(artifact)
    || !statSync(artifactPath).isFile()) {
    throw new Error('Executor update feed does not match release version, protocol, or CJS artifact')
  }
  return true
}

export function assertLocalDedicatedVerification({ enabled, privateCloudRuntime, requireSigned, manifest, hasUpdateFeed, hasWindowsPayload, signaturePresent }) {
  if (!enabled) return
  if (privateCloudRuntime || requireSigned || process.platform !== 'linux' || process.arch !== 'x64'
    || manifest.component !== 'all'
    || JSON.stringify(manifest.nativeTargets) !== '[]'
    || !hasUpdateFeed || hasWindowsPayload || signaturePresent) {
    throw new Error('local Dedicated verification requires a signed Linux x64 all-component CJS stage without Windows assets or a Sigstore bundle; cannot combine with --private-cloud-runtime or --require-signed')
  }
}
