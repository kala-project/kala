import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyPortablePublic } from './verify-portable-public.mjs'

const tag = 'v0.3.0-beta.19'
const revision = '0123456789abcdef0123456789abcdef01234567'
const digest = 'sha256:' + 'a'.repeat(64)
const image = `ghcr.io/xingsy97/kala-portable@${digest}`
const metadata = {
  schemaVersion: 1, status: 'isolated-vm-accepted', image, platform: 'linux/amd64', tag, revision,
  checks: { imageSignature: true, provenance: true, sbom: true, isolatedVmAcceptance: true }, publicPromotion: false,
}
const acceptance = {
  architecture: 'amd64', category: 'portable-container', checks: {
    capabilities: true, dashboard: true, loopbackPublish: true, nonRoot: true, persistentVolume: true, sessionPersistence: true,
  }, image, imageId: 'sha256:' + 'b'.repeat(64), ok: true, revision, tag, version: tag.slice(1),
}
const request = (fetchImpl, overrides = {}) => verifyPortablePublic({ metadata, acceptance, tag, revision, repository: 'xingsy97/kala', fetchImpl, ...overrides })

test('only an anonymously retrievable immutable digest may pass without Packages API access', async () => {
  const urls = []
  const result = await request(async (url, options) => {
    urls.push({ url, options })
    assert.ok(!url.includes('api.github.com'))
    if (url.includes('/token?')) return { status: 200, json: async () => ({ token: 'anonymous-test' }) }
    return { status: 200, headers: { get: () => digest } }
  })
  assert.equal(result.anonymousDigest, digest)
  assert.equal(urls.length, 2)
  assert.equal(urls[1].options.method, 'HEAD')
  assert.equal(urls[1].url, `https://ghcr.io/v2/xingsy97/kala-portable/manifests/${digest}`)
})

test('a private package, stale digest, or mismatched VM evidence fails closed', async () => {
  await assert.rejects(request(async () => ({ status: 403 })), /refused an anonymous pull token/u)
  await assert.rejects(request(async (url) => url.includes('/token?')
    ? { status: 200, json: async () => ({ token: 'anonymous-test' }) }
    : { status: 401, headers: { get: () => null } }), /not anonymously retrievable/u)
  await assert.rejects(request(async (url) => url.includes('/token?')
    ? { status: 200, json: async () => ({ token: 'anonymous-test' }) }
    : { status: 200, headers: { get: () => 'sha256:' + 'c'.repeat(64) } }), /not anonymously retrievable/u)
  await assert.rejects(request(async () => { throw new Error('network must not run') }, {
    acceptance: { ...acceptance, revision: 'd'.repeat(40) },
  }), /Expected values to be strictly equal/u)
})
