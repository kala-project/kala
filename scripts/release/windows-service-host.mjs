import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'

export const WINDOWS_SERVICE_HOST = Object.freeze({
  asset: 'kala-executor-service-host-win32-x64.exe',
  product: 'WinSW',
  version: '2.12.0',
  upstreamAsset: 'WinSW-x64.exe',
  sourceUrl: 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe',
  license: 'MIT',
  bytes: 18_243_033,
  sha256: '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da',
})

export async function stageWindowsServiceHost(outputPath, { fetchImpl = globalThis.fetch, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required to download the pinned Windows service host')
  for (let attempt = 1; attempt <= 3; attempt++) {
    let response
    try {
      response = await fetchImpl(WINDOWS_SERVICE_HOST.sourceUrl, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
    } catch (error) {
      throw new Error(`failed to download pinned WinSW ${WINDOWS_SERVICE_HOST.version}: ${error.message}`)
    }
    if (!response.ok) {
      if ([502, 503, 504].includes(response.status) && attempt < 3) {
        await delay(attempt * 10_000)
        continue
      }
      throw new Error(`failed to download pinned WinSW ${WINDOWS_SERVICE_HOST.version}: HTTP ${response.status}`)
    }
    if (new URL(response.url || WINDOWS_SERVICE_HOST.sourceUrl).protocol !== 'https:') {
      throw new Error('pinned WinSW download redirected away from HTTPS')
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    verifyWindowsServiceHostBytes(bytes)
    writeFileSync(outputPath, bytes, { mode: 0o755 })
    return WINDOWS_SERVICE_HOST
  }
}

export function verifyWindowsServiceHost(path) {
  const stat = lstatSync(path)
  if (!stat.isFile()) throw new Error('Windows service host must be a regular file')
  const bytes = readFileSync(path)
  verifyWindowsServiceHostBytes(bytes)
  return WINDOWS_SERVICE_HOST
}

export function verifyWindowsServiceHostBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes)
  if (bytes.length !== WINDOWS_SERVICE_HOST.bytes) {
    throw new Error(`WinSW size mismatch: expected ${WINDOWS_SERVICE_HOST.bytes}, received ${bytes.length}`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== WINDOWS_SERVICE_HOST.sha256) throw new Error('WinSW SHA-256 mismatch')
  if (bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('WinSW is not a PE executable')
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset + 6 > bytes.length || bytes.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('WinSW has an invalid PE header')
  }
  if (bytes.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error('WinSW is not an x64 PE executable')
}

export function windowsServiceHostManifestMetadata() {
  return {
    asset: WINDOWS_SERVICE_HOST.asset,
    product: WINDOWS_SERVICE_HOST.product,
    version: WINDOWS_SERVICE_HOST.version,
    upstreamAsset: WINDOWS_SERVICE_HOST.upstreamAsset,
    sourceUrl: WINDOWS_SERVICE_HOST.sourceUrl,
    license: WINDOWS_SERVICE_HOST.license,
    bytes: WINDOWS_SERVICE_HOST.bytes,
    sha256: WINDOWS_SERVICE_HOST.sha256,
  }
}
