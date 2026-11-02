#!/usr/bin/env node
// Install-time smoke for pre-built release artifacts. It always runs the Portable
// Host from a clean directory with only its embedded assets available. When the
// finalized release contains the Windows installer payload, it also runs against
// the adjacent complete release directory and verifies both delivery modes.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { extractDedicatedSupportBundle, DEDICATED_SUPPORT_ARCHIVE } from './dedicated-support-bundle.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const releaseDir = join(repoRoot, 'release')
const manifestPath = join(releaseDir, 'manifest.json')
const hostAsset = 'kala-dashboard-with-runtime.cjs'
const windowsAssets = [
  'kala-executor-win32-x64.exe',
  'kala-executor-service-host-win32-x64.exe',
  'node-pty-win32-x64.tar.gz',
  'install-executor.ps1',
]

if (!existsSync(manifestPath)) fail('missing release/manifest.json — run build-release-assets first')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (!Array.isArray(manifest.assets)) fail('release manifest missing assets array')
for (const asset of [hostAsset, DEDICATED_SUPPORT_ARCHIVE]) {
  if (!manifest.assets.includes(asset) || !existsSync(join(releaseDir, asset))) fail(`missing required manifest asset: ${asset}`)
}
const hasWindowsPayload = windowsAssets.every((asset) => manifest.assets.includes(asset) && existsSync(join(releaseDir, asset)))
if (windowsAssets.some((asset) => manifest.assets.includes(asset) || existsSync(join(releaseDir, asset))) && !hasWindowsPayload) {
  fail('release contains an incomplete Windows installation payload')
}

try {
  await smokeHost({ label: 'standalone embedded-only', releaseAssetsDir: undefined, expectWindows: hasWindowsPayload })
  if (hasWindowsPayload) {
    await smokeHost({ label: 'adjacent complete release', releaseAssetsDir: releaseDir, expectWindows: true })
  }
  console.log(`release install smoke passed (${hasWindowsPayload ? 'standalone and adjacent Windows delivery' : 'standalone without Windows payload'})`)
} catch (err) {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}

async function smokeHost({ label, releaseAssetsDir, expectWindows }) {
  const installDir = mkdtempSync(join(tmpdir(), 'agent-kernel-install-'))
  const sessionsDir = join(installDir, 'sessions')
  const artifactsDir = join(installDir, 'artifacts')
  mkdirSync(sessionsDir, { recursive: true })
  mkdirSync(artifactsDir, { recursive: true })
  copyFileSync(join(releaseDir, hostAsset), join(installDir, hostAsset))
  copyFileSync(join(releaseDir, DEDICATED_SUPPORT_ARCHIVE), join(installDir, DEDICATED_SUPPORT_ARCHIVE))
  const supportDir = join(installDir, 'support')
  extractDedicatedSupportBundle(join(installDir, DEDICATED_SUPPORT_ARCHIVE), supportDir)
  copyFileSync(join(supportDir, 'deployment.json'), join(installDir, 'deployment.json'))

  const port = await findFreePort()
  const env = {
    ...process.env,
    KALA_PORT: String(port),
    KALA_SESSIONS_DIR: sessionsDir,
    KALA_ARTIFACTS_DIR: artifactsDir,
    KALA_RELEASE_ASSETS_DIR: releaseAssetsDir ?? join(installDir, 'intentionally-empty-release-assets'),
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'smoke-key-not-used',
    KALA_ALLOW_ALL_OK: '0',
    KALA_DEPLOYMENT_CONFIG: join(installDir, 'deployment.json'),
  }
  delete env.HOME_INSTANCE
  delete env.KALA_AUTH_TOKEN
  delete env.KALA_DASHBOARD_DIR

  const child = spawn('node', [join(installDir, hostAsset)], { cwd: installDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  const exitPromise = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))

  try {
    await waitForServer(port, 15_000)
    const url = `http://127.0.0.1:${port}`
    const capabilitiesRes = await fetch(`${url}/runtime/capabilities`)
    const capabilities = await capabilitiesRes.json()
    if (capabilitiesRes.status !== 200 || capabilities.product !== 'dedicated' || capabilities.deployment?.tenancy !== 'single-tenant') {
      throw new Error(`${label}: release install did not load canonical Dedicated deployment config`)
    }
    const unauthenticatedInstallCapabilities = await fetch(`${url}/api/executor-install-capabilities`)
    if (unauthenticatedInstallCapabilities.status !== 401) {
      throw new Error(`${label}: unauthenticated install capabilities returned ${unauthenticatedInstallCapabilities.status}`)
    }
    const installCapabilitiesRes = await fetch(`${url}/api/executor-install-capabilities`, {
      headers: {
        'x-agent-runlab-principal': 'release-install-smoke',
        'x-agent-runlab-organization-id': 'release-install-smoke',
        'x-agent-runlab-organization-role': 'owner',
      },
    })
    const installCapabilities = await installCapabilitiesRes.json()
    if (installCapabilitiesRes.status !== 200 || installCapabilities?.platforms?.windows?.available !== expectWindows) {
      throw new Error(`${label}: Windows install capability was ${JSON.stringify(installCapabilities)}`)
    }

    const manifestRes = await fetch(`${url}/artifacts/manifest`)
    if (!manifestRes.ok) throw new Error(`${label}: GET /artifacts/manifest returned ${manifestRes.status}`)
    const manifestBody = await manifestRes.json()
    if (manifestBody?.schemaVersion !== 1 || !Array.isArray(manifestBody?.entries) || typeof manifestBody?.summary?.entryCount !== 'number') {
      throw new Error(`${label}: GET /artifacts/manifest returned unexpected shape`)
    }
    const dashboardRes = await fetch(`${url}/`, { redirect: 'manual' })
    const dashboardHtml = await dashboardRes.text()
    if (dashboardRes.status !== 200 || !dashboardHtml.includes('<html')) throw new Error(`${label}: embedded dashboard was not served`)

    const runResponse = await fetch(`${url}/install/assets/run.sh`)
    if (runResponse.status !== 200 || !runResponse.headers.get('content-type')?.includes('text/x-shellscript')) {
      throw new Error(`${label}: run.sh was not served as a shell installer`)
    }
    if (await runResponse.text() !== readFileSync(join(releaseDir, 'run.sh'), 'utf8')) throw new Error(`${label}: run.sh bytes differ from release`)

    if (expectWindows) {
      const delivered = new Map()
      for (const asset of [...windowsAssets, 'SHA256SUMS']) {
        const response = await fetch(`${url}/install/assets/${asset}`)
        if (response.status !== 200) throw new Error(`${label}: GET /install/assets/${asset} returned ${response.status}`)
        delivered.set(asset, Buffer.from(await response.arrayBuffer()))
      }
      for (const asset of windowsAssets) {
        if (!delivered.get(asset).equals(readFileSync(join(releaseDir, asset)))) throw new Error(`${label}: ${asset} bytes differ from release`)
      }
      assertChecksumIndex(delivered.get('SHA256SUMS').toString('utf8'), delivered, label, { embeddedOnly: !releaseAssetsDir })
      if (releaseAssetsDir && !delivered.get('SHA256SUMS').equals(readFileSync(join(releaseDir, 'SHA256SUMS')))) {
        throw new Error(`${label}: adjacent SHA256SUMS differs from finalized release index`)
      }
    } else {
      for (const asset of ['install-executor.ps1', 'node-pty-win32-x64.tar.gz', 'kala-executor-service-host-win32-x64.exe']) {
        const response = await fetch(`${url}/install/assets/${asset}`)
        if (response.status !== 404) throw new Error(`${label}: unsupported ${asset} returned ${response.status}`)
      }
    }
  } catch (err) {
    console.error(`--- ${label} host stdout ---\n${stdout}`)
    console.error(`--- ${label} host stderr ---\n${stderr}`)
    throw err
  } finally {
    child.kill('SIGTERM')
    const exit = await Promise.race([exitPromise, new Promise((resolve) => setTimeout(() => resolve({ signal: 'timeout' }), 5000))])
    if (exit?.signal === 'timeout') child.kill('SIGKILL')
    rmSync(installDir, { recursive: true, force: true })
  }
}

function assertChecksumIndex(index, delivered, label, { embeddedOnly }) {
  const entries = new Map()
  for (const line of index.split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u)
    if (!match || entries.has(match[2])) throw new Error(`${label}: SHA256SUMS is malformed or contains duplicates`)
    entries.set(match[2], match[1])
  }
  if (entries.has('SHA256SUMS')) throw new Error(`${label}: SHA256SUMS contains itself`)
  if (embeddedOnly && entries.has(hostAsset)) throw new Error(`${label}: embedded SHA256SUMS contains the Portable Host`)
  if (!embeddedOnly && !entries.has(hostAsset)) throw new Error(`${label}: finalized SHA256SUMS omits the Portable Host`)
  for (const asset of windowsAssets) {
    const actual = createHash('sha256').update(delivered.get(asset)).digest('hex')
    if (entries.get(asset) !== actual) throw new Error(`${label}: SHA256SUMS does not authenticate ${asset}`)
  }
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/models`)).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`host did not start on port ${port} within ${timeoutMs}ms`)
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address && typeof address.port === 'number') server.close(() => resolve(address.port))
      else server.close(() => reject(new Error('failed to allocate ephemeral port')))
    })
    server.on('error', reject)
  })
}

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exit(1)
}
