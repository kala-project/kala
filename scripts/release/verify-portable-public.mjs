#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPortableAcceptanceEvidence } from './verify-portable-evidence.mjs'

export async function verifyPortablePublic({ metadata, acceptance, tag, revision, repository, fetchImpl = fetch }) {
  assert.equal(repository, 'kala-project/kala', 'unexpected Portable package ownership')
  assert.deepEqual(Object.keys(metadata).sort(), ['schemaVersion', 'status', 'image', 'platform', 'tag', 'revision', 'checks', 'publicPromotion'].sort())
  assert.equal(metadata.schemaVersion, 1)
  assert.equal(metadata.status, 'isolated-vm-accepted')
  assert.equal(metadata.platform, 'linux/amd64')
  assert.equal(metadata.tag, tag)
  assert.equal(metadata.revision, revision)
  assert.equal(metadata.publicPromotion, false, 'candidate metadata must not claim public promotion in advance')
  assert.deepEqual(Object.keys(metadata.checks).sort(), ['imageSignature', 'provenance', 'sbom', 'isolatedVmAcceptance'].sort())
  for (const result of Object.values(metadata.checks)) assert.equal(result, true)
  const imageMatch = metadata.image.match(/^ghcr\.io\/kala-project\/kala-portable@(sha256:[0-9a-f]{64})$/u)
  assert.ok(imageMatch, 'image must be the exact immutable Portable package digest')
  verifyPortableAcceptanceEvidence(acceptance, { image: metadata.image, tag, revision })

  // Query GHCR without a repository token or docker login. GitHub's Packages
  // REST endpoint can require authentication even when the registry permits
  // anonymous pulls; promotion separately pulls every layer with empty Docker credentials.
  const tokenResponse = await fetchImpl('https://ghcr.io/token?service=ghcr.io&scope=repository:kala-project/kala-portable:pull', { cache: 'no-store' })
  if (tokenResponse.status !== 200) throw new Error('GHCR refused an anonymous pull token')
  const anonymousToken = (await tokenResponse.json()).token
  if (typeof anonymousToken !== 'string' || !anonymousToken) throw new Error('GHCR anonymous pull token is unavailable')
  const manifestResponse = await fetchImpl(`https://ghcr.io/v2/kala-project/kala-portable/manifests/${imageMatch[1]}`, {
    method: 'HEAD', cache: 'no-store', headers: {
      authorization: `Bearer ${anonymousToken}`,
      accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json',
    },
  })
  if (manifestResponse.status !== 200 || manifestResponse.headers.get('docker-content-digest') !== imageMatch[1]) {
    throw new Error('Portable image digest is not anonymously retrievable from GHCR')
  }
  return { ok: true, image: metadata.image, anonymousDigest: imageMatch[1] }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const metadata = JSON.parse(readFileSync(resolve(required('--metadata')), 'utf8'))
    const acceptance = JSON.parse(readFileSync(resolve(required('--acceptance')), 'utf8'))
    const result = await verifyPortablePublic({ metadata, acceptance, tag: required('--tag'), revision: required('--revision'), repository: required('--repository') })
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

function required(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`)
  return process.argv[index + 1]
}
