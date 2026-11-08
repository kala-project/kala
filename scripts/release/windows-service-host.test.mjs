import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

import {
  stageWindowsServiceHost,
  verifyWindowsServiceHost,
  verifyWindowsServiceHostBytes,
  WINDOWS_SERVICE_HOST,
  windowsServiceHostManifestMetadata,
} from './windows-service-host.mjs'

test('pins the independently named WinSW x64 service host supply-chain identity', () => {
  assert.deepEqual(windowsServiceHostManifestMetadata(), {
    asset: 'kala-executor-service-host-win32-x64.exe',
    product: 'WinSW',
    version: '2.12.0',
    upstreamAsset: 'WinSW-x64.exe',
    sourceUrl: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe',
    license: 'MIT',
    bytes: 18_243_033,
    sha256: '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da',
  })
  assert.notEqual(WINDOWS_SERVICE_HOST.asset, WINDOWS_SERVICE_HOST.upstreamAsset)
})

test('fails closed on unavailable, resized, or changed service-host content', async () => {
  await assert.rejects(
    stageWindowsServiceHost('/unused', { fetchImpl: async () => { throw new Error('offline') } }),
    /failed to download pinned WinSW 2\.12\.0: offline/u,
  )
  assert.throws(() => verifyWindowsServiceHostBytes(Buffer.from('MZ')), /size mismatch/u)
  const wrong = Buffer.alloc(WINDOWS_SERVICE_HOST.bytes)
  wrong.write('MZ')
  assert.throws(() => verifyWindowsServiceHostBytes(wrong), /SHA-256 mismatch/u)
})

test('retries temporary WinSW gateway failures without accepting unverified bytes', async () => {
  let attempts = 0
  const delays = []
  await assert.rejects(
    stageWindowsServiceHost('/unused', {
      fetchImpl: async () => { attempts++; return { ok: false, status: 504 } },
      delay: async (ms) => { delays.push(ms) },
    }),
    /failed to download pinned WinSW 2\.12\.0: HTTP 504/u,
  )
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [10_000, 20_000])

  attempts = 0
  await assert.rejects(
    stageWindowsServiceHost('/unused', {
      fetchImpl: async () => ++attempts === 1
        ? { ok: false, status: 503 }
        : { ok: true, url: WINDOWS_SERVICE_HOST.sourceUrl, arrayBuffer: async () => Buffer.from('MZ') },
      delay: async () => {},
    }),
    /WinSW size mismatch/u,
  )
  assert.equal(attempts, 2)
})

test('accepts the separately acquired official WinSW fixture when available', (t) => {
  const fixture = process.env.KALA_TEST_WINSW_PATH || '/tmp/kala-winsw-v2.12.0-x64.exe'
  if (!existsSync(fixture)) return t.skip('official WinSW fixture is not present')
  assert.equal(verifyWindowsServiceHost(fixture), WINDOWS_SERVICE_HOST)
})
