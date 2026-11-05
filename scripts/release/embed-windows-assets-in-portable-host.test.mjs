import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  embedWindowsAssetsInPortableHost,
  PORTABLE_HOST_ASSET,
  WINDOWS_INSTALL_PAYLOADS,
} from './embed-windows-assets-in-portable-host.mjs'
import { createDashboardArchive, dashboardArchiveName } from './release-archives.mjs'

const revision = '1234567890abcdef1234567890abcdef12345678'
const repo = 'example/kala'
const tag = 'v1.2.3'

test('embeds verified Windows payloads with a payload-only checksum index', () => {
  const dir = fixture()
  try {
    const beforePublicIndex = readFileSync(join(dir, 'SHA256SUMS'), 'utf8')
    const result = embedWindowsAssetsInPortableHost({ directory: dir, repo, tag, expectedRevision: revision })
    const embedded = banner(readFileSync(result.hostPath, 'utf8'), 'globalThis.__KALA_EMBEDDED_RELEASE_ASSETS__=')
    const assets = new Map(embedded.map((asset) => [asset.path, Buffer.from(asset.contentBase64, 'base64')]))

    assert.equal(readFileSync(join(dir, 'SHA256SUMS'), 'utf8'), beforePublicIndex, 'post-processing must not replace the final/public checksum index')
    assert.equal(assets.has(PORTABLE_HOST_ASSET), false, 'the Host must never embed itself')
    assert.deepEqual(WINDOWS_INSTALL_PAYLOADS.filter((name) => !assets.has(name)), [])
    assert.equal(assets.get('run.sh')?.toString('utf8'), '#!/bin/sh\necho existing\n')

    const index = assets.get('SHA256SUMS')?.toString('utf8') ?? ''
    assert.doesNotMatch(index, new RegExp(`  ${PORTABLE_HOST_ASSET.replaceAll('.', '\\.')}$`, 'mu'))
    assert.doesNotMatch(index, /  SHA256SUMS$/mu)
    for (const name of ['run.sh', ...WINDOWS_INSTALL_PAYLOADS]) {
      const expected = createHash('sha256').update(assets.get(name)).digest('hex')
      assert.match(index, new RegExp(`^${expected}  ${name.replaceAll('.', '\\.')}$$`, 'mu'))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preserves the Windows-built Host while embedding the exact release Dashboard bytes', () => {
  const dir = fixture()
  try {
    const dist = join(dir, 'dashboard')
    mkdirSync(join(dist, 'brand'), { recursive: true })
    const path = 'brand/kala-wordmark-light.svg'
    const canonical = Buffer.from('<svg>release</svg>\n')
    const index = Buffer.from('<html>Dashboard</html>\n')
    writeFileSync(join(dist, path), canonical)
    writeFileSync(join(dist, 'index.html'), index)
    const files = [
      { path, bytes: canonical.length, sha256: createHash('sha256').update(canonical).digest('hex') },
      { path: 'index.html', bytes: index.length, sha256: createHash('sha256').update(index).digest('hex') },
    ]
    const manifestPath = join(dir, 'dashboard-release.json')
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, product: 'kala-dashboard', version: '1.2.3', source: { revision }, assetDigest: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files }))
    createDashboardArchive({ dashboardDist: dist, manifestPath, outputPath: join(dir, dashboardArchiveName) })
    const hostPath = join(dir, PORTABLE_HOST_ASSET)
    const captured = [
      { path, contentBase64: Buffer.from('<svg>release</svg>\r\n').toString('base64') },
      { path: 'index.html', contentBase64: index.toString('base64') },
    ]
    writeFileSync(hostPath, readFileSync(hostPath, 'utf8').replace("console.log('fixture')", `globalThis.__KALA_EMBEDDED_DASHBOARD__=${JSON.stringify(captured)};\nconsole.log('fixture')`))

    embedWindowsAssetsInPortableHost({ directory: dir, repo, tag, expectedRevision: revision, canonicalDashboard: true })
    const host = readFileSync(hostPath, 'utf8')
    const embedded = banner(host, 'globalThis.__KALA_EMBEDDED_DASHBOARD__=')
    assert.deepEqual(Buffer.from(embedded[0].contentBase64, 'base64'), canonical)
    assert.match(host, /console\.log\('fixture'\)/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fails closed when manifest and Portable Host identities do not match the expected revision', () => {
  const dir = fixture()
  try {
    assert.throws(
      () => embedWindowsAssetsInPortableHost({ directory: dir, repo, tag, expectedRevision: 'a'.repeat(40) }),
      /release manifest source revision mismatch/u,
    )
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    manifest.source.revision = 'a'.repeat(40)
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
    assert.throws(
      () => embedWindowsAssetsInPortableHost({ directory: dir, repo, tag, expectedRevision: 'a'.repeat(40) }),
      /Portable Host source revision mismatch/u,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kala-portable-host-assets-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    repo,
    tag,
    version: '1.2.3',
    source: { revision },
    assets: [PORTABLE_HOST_ASSET],
  }))
  const existingAssets = [
    { path: 'run.sh', contentBase64: Buffer.from('#!/bin/sh\necho existing\n').toString('base64') },
    { path: 'SHA256SUMS', contentBase64: Buffer.from('stale embedded index\n').toString('base64') },
  ]
  writeFileSync(join(dir, PORTABLE_HOST_ASSET), [
    '#!/usr/bin/env node',
    `globalThis.__KALA_BUILD_INFO__=${JSON.stringify({ releaseTag: tag, gitCommit: revision.slice(0, 12) })};`,
    `globalThis.__KALA_EMBEDDED_RELEASE_ASSETS__=${JSON.stringify(existingAssets)};`,
    "console.log('fixture')",
    '',
  ].join('\n'), { mode: 0o755 })
  for (const name of WINDOWS_INSTALL_PAYLOADS.filter((asset) => asset !== 'install-executor.ps1')) {
    writeFileSync(join(dir, name), `fixture:${name}\n`)
  }
  writeFileSync(join(dir, 'SHA256SUMS'), 'public checksum sentinel\n')
  return dir
}

function banner(source, prefix) {
  const line = source.split('\n').find((candidate) => candidate.startsWith(prefix))
  assert.ok(line?.endsWith(';'))
  return JSON.parse(line.slice(prefix.length, -1))
}
