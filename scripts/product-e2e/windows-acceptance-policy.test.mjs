import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const read = async (path) => await readFile(resolve(root, path), 'utf8')

function job(source, name, nextName) {
  const start = source.indexOf(`  ${name}:`)
  assert.notEqual(start, -1, `missing ${name} job`)
  const end = nextName ? source.indexOf(`  ${nextName}:`, start) : source.length
  assert.notEqual(end, -1, `missing ${nextName} job boundary`)
  return source.slice(start, end)
}

test('Windows Host CJS does not redistribute Copilot runtime binaries', async () => {
  const builder = await read('scripts/release/build-release-assets.mjs')
  assert.doesNotMatch(builder, /stageCopilotRuntime|kala-copilot-runtime-/u)
})

test('hosted Windows acceptance keeps Host CJS and Windows companion stages separate and never uses Box', async () => {
  const workflow = await read('.github/workflows/product-system-e2e.yml')
  const host = job(workflow, 'windows-host-cjs-e2e', 'windows-executor-conpty-e2e')
  const executor = job(workflow, 'windows-executor-conpty-e2e', 'linux-system-e2e')

  for (const source of [host, executor]) {
    assert.match(source, /^    runs-on: windows-latest$/mu)
    assert.doesNotMatch(source, /if:\s*false|self-hosted|\bbox\b|docker|podman|playwright|chromium/iu)
    assert.match(source, /Require GNU tar and gzip from Git for Windows for reproducible archives/u)
    assert.match(source, /Git\\usr\\bin[\s\S]*GITHUB_PATH/u)
    assert.match(source, /TAR_OPTIONS=--force-local/u)
  }
  assert.match(host, /--component host/u)
  assert.match(host, /PRODUCT_E2E_WINDOWS_TARGET: host/u)
  assert.doesNotMatch(host, /--native-only|PRODUCT_E2E_WINDOWS_TARGET: executor/u)

  assert.match(executor, /--component executor --native-only --native-target win32-x64/u)
  assert.match(executor, /kala-executor\.cjs/u)
  assert.match(executor, /node-pty-win32-x64\.tar\.gz/u)
  assert.match(executor, /kala-executor-service-host-win32-x64\.exe/u)
  assert.match(executor, /verifyWindowsServiceHost/u)
  assert.match(executor, /worker\/conoutSocketWorker\.js/u)
  assert.match(executor, /shared\/conout\.js/u)
  assert.match(executor, /prepare-windows-release-fixture\.mjs --host-release/u)
  assert.match(executor, /PRODUCT_E2E_WINDOWS_TARGET: executor/u)
  assert.match(executor, /PRODUCT_E2E_WINDOWS_SERVICE: '1'/u)
  assert.doesNotMatch(executor, /continue-on-error/u)
})

test('Windows verifier fails closed on missing payloads, missing ConPTY, and unsupported Host integration', async () => {
  const verifier = await read('scripts/product-e2e/verify-windows-terminal.mjs')
  assert.match(verifier, /KALA_RELEASE_ASSETS_DIR: hostRelease/u)
  for (const required of [
    'kala-dashboard-with-runtime.cjs',
    'kala-executor.cjs',
    'kala-executor-service-host-win32-x64.exe',
    'conpty.node',
    'conpty_console_list.node',
    'pty.node',
    'winpty-agent.exe',
    'winpty.dll',
    'conoutSocketWorker.js',
    'conout.js',
  ]) assert.match(verifier, new RegExp(required.replaceAll('.', '\\.'), 'u'))
  assert.match(verifier, /platform: 'windows'/u)
  assert.match(verifier, /windows_installation_unsupported/u)
  assert.match(verifier, /integrate the Windows assets into the global release inventory before accepting this target/u)
  assert.match(verifier, /\[Console\]::IsOutputRedirected/u)
  assert.match(verifier, /join\(process\.env\.ProgramFiles, 'Kala', 'Executor'\)/u)
  assert.match(verifier, /join\(process\.env\.ProgramData, 'Kala', 'Executor'\)/u)
  assert.doesNotMatch(verifier, /runlab-executor|Agent RunLab/u)
  assert.match(verifier, /process\.platform !== 'win32' \|\| process\.arch !== 'x64'/u)
})

test('Private Cloud Windows invite verifier uses real ingress with env-only credentials and covers SCM reconnect cleanup', async () => {
  const verifier = await read('scripts/product-e2e/verify-private-cloud-windows-invite.mjs')
  assert.match(verifier, /startRuntimeIngressGateway/u)
  assert.match(verifier, /\/auth\/executor-invites/u)
  assert.match(verifier, /\/install\/invite\.ps1/u)
  assert.match(verifier, /EXECUTOR_INVITE: invite/u)
  assert.match(verifier, /KALA_INVITE_INSTALL_MODE: mode/u)
  assert.match(verifier, /\['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `irm '\$\{origin\}\/install\/invite\.ps1' \| iex`\]/u)
  assert.doesNotMatch(verifier, /console\.(?:log|error)\([^\n]*(?:invite\.token|credential|EXECUTOR_INVITE)/u)
  assert.match(verifier, /client:list_executors/u)
  assert.match(verifier, /\['stop', serviceName\]/u)
  assert.match(verifier, /\['start', serviceName\]/u)
  assert.match(verifier, /config\.routeHint !== invite\.routeHint/u)
  assert.match(verifier, /credential\.startsWith\('ak_invite_'\)/u)
  assert.match(verifier, /identity\.tokenHash !== expectedHash/u)
  assert.match(verifier, /run\(process\.execPath, \[installedExecutor, 'service', 'uninstall'\]\)/u)
  assert.match(verifier, /service uninstall left managed Windows Executor directories/u)
  assert.match(verifier, /process\.platform !== 'win32' \|\| process\.arch !== 'x64'/u)
})

test('Private Cloud release and daily Windows jobs gate on the reusable valid invite E2E', async () => {
  const privateCloud = await read('.github/workflows/private-cloud-release.yml')
  const releaseWindows = job(privateCloud, 'windows-assets', 'runtime-image')
  const releaseGate = releaseWindows.indexOf('node scripts/product-e2e/verify-private-cloud-windows-invite.mjs')
  const upload = releaseWindows.indexOf('actions/upload-artifact@v5')
  assert.match(releaseWindows, /^    runs-on: windows-latest$/mu)
  assert.ok(releaseGate > 0, 'private-cloud windows-assets is missing the valid invite gate')
  assert.ok(upload > releaseGate, 'private-cloud Windows assets upload must follow the valid invite gate')
  assert.doesNotMatch(releaseWindows.slice(releaseGate, upload), /continue-on-error/u)

  const daily = await read('.github/workflows/product-system-e2e.yml')
  const executor = job(daily, 'windows-executor-conpty-e2e', 'linux-system-e2e')
  assert.match(executor, /pnpm --filter @agent-kernel\/runtime-ingress-gateway build/u)
  assert.match(executor, /node scripts\/product-e2e\/verify-private-cloud-windows-invite\.mjs/u)
  assert.doesNotMatch(executor, /continue-on-error/u)
})
