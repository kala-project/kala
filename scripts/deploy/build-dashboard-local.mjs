#!/usr/bin/env node
// Package an already-built Dashboard without rebuilding unrelated Host/Executor
// assets or publishing a complete release candidate.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDashboardArchive, dashboardArchiveName, dashboardManifestName, verifyDashboardArchive } from '../release/release-archives.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const dist = join(root, 'packages/dashboard/dist')
const output = resolve(process.argv[2] ?? join(root, 'release'))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
if (git('status', '--porcelain=v1', '--untracked-files=all')) throw new Error('commit and verify source changes before packaging the Dashboard')
const revision = git('rev-parse', 'HEAD')
const buildTime = new Date(Number(git('show', '-s', '--format=%ct', 'HEAD')) * 1000).toISOString()
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const { PROTOCOL_VERSION } = await import('../../packages/shared/dist/index.js')
if (!existsSync(join(dist, 'index.html'))) throw new Error('Dashboard production build is missing')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const entries = execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean).sort()
const snapshot = createHash('sha256')
for (const entry of entries) {
  const match = entry.match(/^(100644|100755|120000) ([0-9a-f]{40,64}) 0\t(.+)$/u)
  if (!match) throw new Error('unresolved Git index entry')
  snapshot.update(`${match[1]}\0${match[3]}\0${match[2]}\0`)
}
function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name)
    if (item.isDirectory()) return filesIn(path)
    if (!item.isFile() || !statSync(path).isFile()) throw new Error(`unexpected Dashboard dist entry: ${path}`)
    return [path]
  })
}
const files = filesIn(dist).map((file) => {
  const bytes = readFileSync(file)
  return { path: relative(dist, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: hash(bytes) }
}).sort((a, b) => a.path.localeCompare(b.path))
const manifest = {
  schemaVersion: 1, product: 'kala-dashboard', version, builtAt: buildTime,
  source: { revision, snapshotSha256: snapshot.digest('hex'), dirty: false },
  protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
  assetDigest: hash(JSON.stringify(files)), files,
}
mkdirSync(output, { recursive: true })
const manifestPath = join(output, dashboardManifestName)
const archivePath = join(output, dashboardArchiveName)
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
createDashboardArchive({ dashboardDist: dist, manifestPath, outputPath: archivePath })
const verified = verifyDashboardArchive(archivePath)
if (verified.manifest.source.revision !== revision) throw new Error('Dashboard archive source mismatch')
console.log(JSON.stringify({ archivePath, manifestSha256: verified.manifestSha256, revision, files: files.length }))
