import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'

import {
  executorNativeAssetName,
  generateExecutorInstallerPowerShell,
  generateExecutorInstallerSh,
  mapExecutorPlatform,
  windowsExecutorInstallerAssetName,
} from './executor-installer.mjs'

test('maps supported executor OS and architecture aliases', () => {
  assert.equal(mapExecutorPlatform('linux', 'x86_64'), 'linux-x64')
  assert.equal(mapExecutorPlatform('Linux', 'aarch64'), 'linux-arm64')
  assert.equal(mapExecutorPlatform('darwin', 'x86_64'), 'darwin-x64')
  assert.equal(mapExecutorPlatform('macos', 'arm64'), 'darwin-arm64')
  assert.equal(mapExecutorPlatform('windows', 'AMD64'), 'win32-x64')
  assert.equal(mapExecutorPlatform('mingw', 'x86_64'), 'win32-x64')
  assert.equal(mapExecutorPlatform('win32', 'arm64'), undefined)
  assert.equal(mapExecutorPlatform('freebsd', 'x64'), undefined)
  assert.equal(mapExecutorPlatform('linux', 'riscv64'), undefined)
})

test('uses one Kala namespace for native asset names', () => {
  assert.equal(executorNativeAssetName('linux-x64'), 'kala-executor-linux-x64')
  assert.equal(executorNativeAssetName('linux-arm64'), 'kala-executor-linux-arm64')
  assert.equal(executorNativeAssetName('darwin-x64'), 'kala-executor-darwin-x64')
  assert.equal(executorNativeAssetName('darwin-arm64'), 'kala-executor-darwin-arm64')
  assert.equal(executorNativeAssetName('win32-x64'), 'kala-executor-win32-x64.exe')
  assert.throws(() => executorNativeAssetName('win32-arm64'))
  assert.throws(() => executorNativeAssetName('freebsd-x64'))
})

test('generates HTTPS-only, checksummed Bash installer with native or Node.js fallback', () => {
  const sh = generateExecutorInstallerSh({ repo: 'owner/repo', tag: 'v1.2.3' })
  for (const marker of [/release asset URL must use HTTPS/, /--https-only/, /SHA256SUMS/, /kala-executor-/, /--internal-installer/]) assert.match(sh, marker)
  assert.doesNotMatch(sh, /ALLOW_UNSIGNED|unsigned install/)
  assert.match(sh, /kala-executor\.cjs/)
  assert.match(sh, /Node\.js 22\+/)
  assert.doesNotMatch(sh, /manifest\.json/)
  assert.match(sh, /this release supports Linux and macOS only/)
  assert.doesNotMatch(sh, /win32|mingw|msys|cygwin|\.exe|\.ps1|conpty/iu)

  const dir = mkdtempSync(join(tmpdir(), 'runlab-installer-test-'))
  try {
    const path = join(dir, 'run.sh')
    writeFileSync(path, sh)
    const syntax = spawnSync('bash', ['-n', path], { encoding: 'utf8' })
    assert.equal(syntax.status, 0, syntax.stderr)
    const closed = spawnSync('bash', [path], { encoding: 'utf8', env: { ...process.env, KALA_RELEASE_ASSETS_URL: 'http://downloads.example.test/release' } })
    assert.notEqual(closed.status, 0)
    assert.match(`${closed.stdout}${closed.stderr}`, /must use HTTPS/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('generates a signed-checksum Windows x64 installer with an exact ConPTY inventory', () => {
  const ps1 = generateExecutorInstallerPowerShell({ repo: 'owner/repo', tag: 'v1.2.3' })
  assert.equal(windowsExecutorInstallerAssetName(), 'install-executor.ps1')
  for (const marker of [
    /Windows x64/,
    /kala-executor-win32-x64\.exe/,
    /node-pty-win32-x64\.tar\.gz/,
    /kala-executor-service-host-win32-x64\.exe/,
    /SHA256SUMS\.sigstore\.json/,
    /cosign\.Source verify-blob/,
    /SHA256\]::Create\(\)/,
    /ComputeHash\(\$stream\)/,
    /Verifying Windows Executor checksum/,
    /Verifying Windows ConPTY archive checksum/,
    /Verifying Windows service-host checksum/,
    /Checking Windows ConPTY tar inventory/,
    /\.TrimEnd\(\[char\]13\)/,
    /Windows ConPTY tar listed/,
    /Windows ConPTY inventory verified/,
    /Windows ConPTY extracted/,
    /Checking Windows ConPTY manifest/,
    /Hashing Windows ConPTY files/,
    /Windows ConPTY archive verified/,
    /node-pty-companion\.json/,
    /conpty\.node/,
    /worker\/conoutSocketWorker\.js/,
    /shared\/conout\.js/,
    /manifest\.files\)\.Count -ne 7/,
    /unexpected file inventory/,
    /Downloading verified Windows Executor assets/,
    /Verifying Windows ConPTY companion/,
    /Starting verified Windows Executor/,
    /--internal-installer/,
  ]) assert.match(ps1, marker)
  assert.match(ps1, /Push-Location -LiteralPath \$work[\s\S]*?\$tar\.Source -tzf \$companion[\s\S]*?\$tar\.Source -xzf \$companion[\s\S]*?Pop-Location/u)
  assert.doesNotMatch(ps1, /\$tar\.Source -(?:tzf|xzf) \$archive/u)
  assert.match(ps1, /Host-mediated release trust requires a valid internal installation session/)
  assert.match(ps1, /--invite-installer/)
  assert.match(ps1, /KALA_INVITE_INSTALL_MODE/)
  assert.match(ps1, /\$internalSession/)
  assert.match(ps1, /\$inviteSession/)
  assert.match(ps1, /if \(\$hostRelease\) \{ & \$binary @args \} else \{ & \$binary --internal-installer @args \}/)
  assert.doesNotMatch(ps1, /& \$binary --internal-installer @args\s*\n/u, 'organization invite must not execute the Host installation-session entry point')
  assert.match(ps1, /Release downloads require HTTPS except for loopback URLs/)
  assert.match(ps1, /SHA256SUMS must contain exactly one valid entry/)
  assert.match(ps1, /if \(\$hostRelease\) \{[\s\S]*?AllowAutoRedirect = \$false[\s\S]*?GetResponseStream\(\)[\s\S]*?CopyTo\(\$outputStream\)[\s\S]*?\} else \{[\s\S]*?-PassThru/u)
  assert.match(ps1, /ReadWriteTimeout = 60000/u)
  assert.match(ps1, /Fetching verified asset \$name/)
  assert.match(ps1, /Asset download completed \$name/)
  assert.match(ps1, /redirected away from HTTPS/)
  assert.doesNotMatch(ps1, /ALLOW_UNSIGNED|winget|kala-executor\.cjs/iu)
})

test('release builder emits the four-target RC manifest with the Windows native installer', () => {
  const builder = readFileSync(new URL('./build-release-assets.mjs', import.meta.url), 'utf8')
  assert.match(builder, /sourceSnapshotSha256/u)
  assert.match(builder, /release source changed while assets were being built/u)
  assert.match(builder, /bootstrapAssets\.push\('run\.sh'\)/)
  assert.doesNotMatch(builder, /install-executor\.sh|generateExecutorInstallerSh/)
  assert.match(builder, /const nativeTargets = \['linux-x64', 'darwin-x64', 'darwin-arm64', WINDOWS_EXECUTOR_TARGET\]/)
  assert.match(builder, /name: 'kala-executor'/)
  assert.doesNotMatch(builder, /legacyExecutorNativeAssetName|runlab-executor/)
  assert.match(builder, /const supportedNativeBuildTargets = nativeTargets/)
  assert.match(builder, /packageWindowsNodePtyCompanion/)
  assert.match(builder, /stageWindowsServiceHost/)
  assert.match(builder, /windowsServiceHostManifestMetadata/)
  assert.match(builder, /generateExecutorInstallerPowerShell/)
  assert.match(builder, /Windows native release builds are Executor-only; Portable Host remains a Node\.js 22\+ CJS asset/)
  assert.match(builder, /Node SEA builds are not cross-compiled/)
  assert.doesNotMatch(builder, /writeExecutorUpdateManifest/)
})

test('Windows installer architecture detection supports PowerShell 5.1 without RuntimeInformation', () => {
  const ps1 = generateExecutorInstallerPowerShell({ repo: 'owner/repo', tag: 'v1.2.3' })
  assert.doesNotMatch(ps1, /Runtime\.InteropServices|::OSArchitecture/u)
  assert.match(ps1, /\[Environment\]::OSVersion\.Platform -ne \[PlatformID\]::Win32NT/u)
  assert.match(ps1, /\$nativeArchitecture = if \(\$env:PROCESSOR_ARCHITEW6432\) \{ \$env:PROCESSOR_ARCHITEW6432 \} else \{ \$env:PROCESSOR_ARCHITECTURE \}/u)
  assert.match(ps1, /-not \[Environment\]::Is64BitOperatingSystem -or \$nativeArchitecture -ine 'AMD64'/u)
})

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
const hasPowerShell = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' }).status === 0

test('Windows architecture guard accepts AMD64 and rejects unsupported native architectures', { skip: !hasPowerShell }, () => {
  const ps1 = generateExecutorInstallerPowerShell({ repo: 'owner/repo', tag: 'v1.2.3' })
  const start = ps1.indexOf('if ([Environment]::OSVersion.Platform')
  const end = ps1.indexOf("$asset = 'kala-executor-win32-x64.exe'")
  assert.ok(start > 0 && end > start)
  const guard = ps1.slice(start, end)
    .replace('[Environment]::OSVersion.Platform', '$testOSPlatform')
    .replace('[Environment]::Is64BitOperatingSystem', '$testOS64Bit')
  for (const scenario of [
    { name: 'reported PowerShell 5.1 AMD64', process: 'AMD64', native: '', os64: true, accepted: true },
    { name: 'case-insensitive AMD64', process: 'amd64', native: '', os64: true, accepted: true },
    { name: '32-bit PowerShell on x64', process: 'x86', native: 'AMD64', os64: true, accepted: true },
    { name: 'native ARM64', process: 'ARM64', native: '', os64: true, accepted: false },
    { name: 'AMD64 emulation on ARM64', process: 'AMD64', native: 'ARM64', os64: true, accepted: false },
    { name: '32-bit Windows', process: 'x86', native: '', os64: false, accepted: false },
    { name: '32-bit OS with inconsistent environment', process: 'AMD64', native: '', os64: false, accepted: false },
    { name: 'unknown native architecture', process: '', native: '', os64: true, accepted: false },
    { name: 'non-Windows OS', process: 'AMD64', native: '', os64: true, windows: false, accepted: false },
  ]) {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      `$testOSPlatform = [PlatformID]::${scenario.windows === false ? 'Unix' : 'Win32NT'}`,
      `$testOS64Bit = $${scenario.os64}`,
      guard,
      "Write-Output 'architecture accepted'",
    ].join('\n')
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      env: { ...process.env, PROCESSOR_ARCHITECTURE: scenario.process, PROCESSOR_ARCHITEW6432: scenario.native },
    })
    assert.equal(result.status === 0, scenario.accepted, `${scenario.name}: ${result.stdout}\n${result.stderr}`)
    if (scenario.accepted) assert.match(result.stdout, /architecture accepted/u)
    else assert.match(result.stderr, /This installer requires Windows/u)
  }
})

test('generated run.sh executes the checksummed Node fallback from a real release directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runlab-installer-e2e-'))
  const release = join(dir, 'release')
  const bin = join(dir, 'bin')
  const work = join(dir, 'work')
  try {
    mkdirSync(release, { recursive: true })
    mkdirSync(bin, { recursive: true })
    const cjs = 'console.log("fallback executor invoked")\n'
    writeFileSync(join(release, 'kala-executor.cjs'), cjs)
    const hash = createHash('sha256').update(cjs).digest('hex')
    writeFileSync(join(release, 'SHA256SUMS'), `${hash}  kala-executor.cjs\n`)
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\n[ "$1" = -m ] && echo x86_64 || echo Linux\n', { mode: 0o755 })
    writeFileSync(join(bin, 'wget'), '#!/bin/sh\nout=""; while [ $# -gt 0 ]; do [ "$1" = -O ] && { out="$2"; shift 2; continue; }; url="$1"; shift; done; cp "$FAKE_RELEASE_DIR/${url##*/}" "$out"\n', { mode: 0o755 })
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nif [ "$1" = -p ]; then echo 22; exit 0; fi\nprintf "%s\\n" "$@" > "$FAKE_NODE_ARGS"\n', { mode: 0o755 })
    const installer = join(dir, 'install.sh')
    writeFileSync(installer, generateExecutorInstallerSh({ repo: 'owner/repo', tag: 'latest' }), { mode: 0o755 })
    const argsFile = join(dir, 'node-args')
    const result = spawnSync('bash', [installer, '--host', 'https://host.invalid'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KALA_RELEASE_ASSETS_URL: 'https://assets.invalid', KALA_INSTALLER_WORK_DIR: work, FAKE_RELEASE_DIR: release, FAKE_NODE_ARGS: argsFile } })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const invoked = readFileSync(argsFile, 'utf8')
    assert.match(invoked, /kala-executor\.cjs/)
    assert.match(invoked, /--internal-installer/)
    assert.match(invoked, /--host/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('generated shell installer rejects Windows before downloading release metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runlab-installer-windows-test-'))
  const bin = join(dir, 'bin')
  try {
    mkdirSync(bin)
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\n[ "$1" = -m ] && echo x86_64 || echo MINGW64_NT\n', { mode: 0o755 })
    writeFileSync(join(bin, 'wget'), '#!/bin/sh\necho unexpected-download >&2\nexit 99\n', { mode: 0o755 })
    const installer = join(dir, 'install.sh')
    writeFileSync(installer, generateExecutorInstallerSh({ repo: 'owner/repo', tag: 'latest' }), { mode: 0o755 })
    const result = spawnSync('bash', [installer], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}${result.stderr}`, /supports Linux and macOS only/)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /unexpected-download/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
