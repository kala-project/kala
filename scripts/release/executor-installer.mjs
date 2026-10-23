import { WINDOWS_SERVICE_HOST } from './windows-service-host.mjs'

const TARGETS = new Set(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'])

export function mapExecutorPlatform(os, arch) {
  const normalizedOs = {
    linux: 'linux',
    darwin: 'darwin',
    macos: 'darwin',
    win32: 'win32',
    windows: 'win32',
    mingw: 'win32',
    msys: 'win32',
    cygwin: 'win32',
  }[String(os).toLowerCase()]
  const normalizedArch = {
    x64: 'x64',
    x86_64: 'x64',
    amd64: 'x64',
    arm64: 'arm64',
    aarch64: 'arm64',
  }[String(arch).toLowerCase()]
  const target = normalizedOs && normalizedArch ? `${normalizedOs}-${normalizedArch}` : undefined
  return target && TARGETS.has(target) ? target : undefined
}

export function executorNativeAssetName(target) {
  if (!TARGETS.has(target)) throw new Error(`unsupported executor target ${target}`)
  return `kala-executor-${target}${target.startsWith('win32-') ? '.exe' : ''}`
}

export function windowsExecutorInstallerAssetName() {
  return 'install-executor.ps1'
}

export function generateExecutorInstallerSh({ repo, tag }) {
  const base = githubReleaseBase(repo, tag)
  return `#!/usr/bin/env bash
set -euo pipefail
BASE_URL="\${KALA_RELEASE_ASSETS_URL:-${base}}"
MAX_METADATA_BYTES="\${KALA_INSTALLER_MAX_METADATA_BYTES:-1048576}"
WORK_DIR="\${KALA_INSTALLER_WORK_DIR:-$(mktemp -d)}"
mkdir -p "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT
fail() { printf 'Kala installer: %s\\n' "$*" >&2; exit 1; }
command -v wget >/dev/null 2>&1 || fail "wget is required"
command -v uname >/dev/null 2>&1 || fail "uname is required"
case "$BASE_URL" in
  https://*) HTTPS_ONLY=1 ;;
  http://localhost/*|http://localhost:*/*|http://127.0.0.1/*|http://127.0.0.1:*/*|http://\\[::1\\]/*|http://\\[::1\\]:*/*) HTTPS_ONLY=0 ;;
  *) fail "release asset URL must use HTTPS" ;;
esac
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m | tr '[:upper:]' '[:lower:]')
case "$os" in linux) os=linux ;; darwin) os=darwin ;; *) fail "unsupported OS: $os (this release supports Linux and macOS only)" ;; esac
case "$arch" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) fail "unsupported architecture: $arch" ;; esac
target="$os-$arch"
asset="kala-executor-$target"
download_file() {
  name="$1"
  if [ "$HTTPS_ONLY" = 1 ]; then
    wget -q --https-only --tries=3 --timeout=30 -O "$WORK_DIR/$name" "$BASE_URL/$name" || fail "failed to download $name"
  else
    wget -q --tries=3 --timeout=30 -O "$WORK_DIR/$name" "$BASE_URL/$name" || fail "failed to download $name"
  fi
}
download_metadata() {
  name="$1"; download_file "$name"
  size=$(wc -c < "$WORK_DIR/$name" | tr -d ' '); [ "$size" -le "$MAX_METADATA_BYTES" ] || fail "$name exceeds metadata size limit"
}
download_metadata SHA256SUMS
expected=$(awk -v file="$asset" '$2 == file && $1 ~ /^[0-9a-fA-F]{64}$/ {print tolower($1)}' "$WORK_DIR/SHA256SUMS")
use_node=0
if [ -z "$expected" ]; then
  asset="kala-executor.cjs"
  expected=$(awk -v file="$asset" '$2 == file && $1 ~ /^[0-9a-fA-F]{64}$/ {print tolower($1)}' "$WORK_DIR/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS has no valid entry for the native Executor or Node.js fallback"
  command -v node >/dev/null 2>&1 || fail "No native Executor is published for $target. Install Node.js 22+ and retry."
  node_major=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)
  [ "$node_major" -ge 22 ] || fail "Node.js 22+ is required for the Executor fallback (found $(node --version 2>/dev/null || printf unknown))"
  use_node=1
fi
download_file "$asset"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$WORK_DIR/$asset" | awk '{print $1}'); elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$WORK_DIR/$asset" | awk '{print $1}'); else fail "sha256sum or shasum is required"; fi
[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset"
if [ "$use_node" = 1 ]; then exec node "$WORK_DIR/$asset" --internal-installer "$@"; fi
chmod +x "$WORK_DIR/$asset"
exec "$WORK_DIR/$asset" --internal-installer "$@"
`
}

export function generateExecutorInstallerPowerShell({ repo, tag }) {
  const base = githubReleaseBase(repo, tag)
  return `# Kala Windows x64 Executor installer
$ErrorActionPreference = 'Stop'
$repo = '${repo}'
$baseUrl = if ($env:KALA_RELEASE_BASE_URL) { $env:KALA_RELEASE_BASE_URL.TrimEnd('/') } else { '${base}' }
$maxMetadataBytes = if ($env:KALA_INSTALLER_MAX_METADATA_BYTES) { [int64]$env:KALA_INSTALLER_MAX_METADATA_BYTES } else { 1048576 }
$uri = [Uri]$baseUrl
$isLoopback = $uri.IsLoopback -and $uri.Scheme -eq 'http'
$publicRelease = $uri.Scheme -eq 'https'
$hostRelease = $false
if (-not $publicRelease -and -not $isLoopback -and $env:KALA_RELEASE_TRUST -ne 'host') { throw 'Release downloads require HTTPS except for loopback URLs' }
if ($env:KALA_RELEASE_TRUST -eq 'host') {
  $hostAssetBase = if ($env:HOST_URL) { $env:HOST_URL.TrimEnd('/') + '/install/assets' } else { '' }
  $internalSession = $args.Count -eq 1 -and $args[0] -eq '--internal-installer' -and $env:EXECUTOR_INSTALL_ID -and $env:EXECUTOR_INSTALL_BOOTSTRAP
  $inviteSession = $args.Count -eq 1 -and $args[0] -eq '--invite-installer' -and $env:EXECUTOR_INVITE -match '^ak_invite_[A-Za-z0-9_-]+$' -and @('temporary', 'service') -contains $env:KALA_INVITE_INSTALL_MODE
  if ((-not $internalSession -and -not $inviteSession) -or -not $hostAssetBase -or $baseUrl -ne $hostAssetBase) {
    throw 'Host-mediated release trust requires a valid internal installation session'
  }
  $hostUri = [Uri]$env:HOST_URL
  if ($hostUri.UserInfo -or $hostUri.Query -or $hostUri.Fragment -or ($hostUri.Scheme -ne 'https' -and -not ($hostUri.Scheme -eq 'http' -and $hostUri.IsLoopback))) { throw 'Host-mediated release trust requires a secure Host URL' }
  $publicRelease = $false
  $hostRelease = $true
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This installer requires Windows' }
# Windows PowerShell 5.1 can expose RuntimeInformation without OSArchitecture.
# PROCESSOR_ARCHITEW6432 identifies the native OS when running under emulation.
$nativeArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if (-not [Environment]::Is64BitOperatingSystem -or $nativeArchitecture -ine 'AMD64') { throw "This installer requires Windows x64 (detected native architecture: $nativeArchitecture)" }
$asset = 'kala-executor-win32-x64.exe'
$companion = 'node-pty-win32-x64.tar.gz'
$serviceHost = '${WINDOWS_SERVICE_HOST.asset}'
$work = if ($env:KALA_INSTALLER_WORK_DIR) { $env:KALA_INSTALLER_WORK_DIR } else { Join-Path ([IO.Path]::GetTempPath()) ('kala-installer-' + [guid]::NewGuid()) }
New-Item -ItemType Directory -Path $work -Force | Out-Null
function Download-ReleaseAsset([string]$name) {
  $destination = Join-Path $work $name
  Write-Host "Fetching verified asset $name..."
  if ($hostRelease) {
    # PowerShell 5.1's Invoke-WebRequest can buffer large native payloads even
    # with -OutFile. Stream the exact Host URL directly, never following redirects.
    $url = "$baseUrl/$name"
    $request = [Net.HttpWebRequest]::Create($url)
    $request.AllowAutoRedirect = $false
    $request.Timeout = 60000
    $request.ReadWriteTimeout = 60000
    $response = $null
    try {
      $response = [Net.HttpWebResponse]$request.GetResponse()
      if ($response.StatusCode -ne [Net.HttpStatusCode]::OK -or $response.ResponseUri.AbsoluteUri -cne $url) { throw "Release asset $name redirected away from the trusted Host" }
      $inputStream = $response.GetResponseStream()
      $outputStream = [IO.File]::Create($destination)
      try { $inputStream.CopyTo($outputStream) }
      finally { $outputStream.Dispose(); $inputStream.Dispose() }
      if ($response.ContentLength -ge 0 -and (Get-Item $destination).Length -ne $response.ContentLength) { throw "Release asset $name was truncated" }
    } finally { if ($response) { $response.Close() } }
  } else {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$name" -OutFile $destination -PassThru
    $finalUri = if ($response.BaseResponse.ResponseUri) { $response.BaseResponse.ResponseUri } elseif ($response.BaseResponse.RequestMessage) { $response.BaseResponse.RequestMessage.RequestUri } else { [Uri]"$baseUrl/$name" }
    if ($publicRelease -and $finalUri.Scheme -ne 'https') { throw "Release asset $name redirected away from HTTPS" }
  }
  Write-Host "Asset download completed $name"
  return $destination
}
function Read-ExpectedDigest([string]$name, [string[]]$sums) {
  $escaped = [regex]::Escape($name)
  $pattern = "^([0-9a-fA-F]{64})  " + $escaped + '$'
  $entries = @($sums | ForEach-Object {
    $entry = [regex]::Match($_, $pattern)
    if ($entry.Success) { $entry.Groups[1].Value }
  })
  if ($entries.Count -ne 1) { throw "SHA256SUMS must contain exactly one valid entry for $name" }
  return ([string]$entries[0]).ToLowerInvariant()
}
function Assert-Digest([string]$path, [string]$expected, [string]$name) {
  $stream = [IO.File]::OpenRead($path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
  if ($actual -ne $expected) { throw "Checksum mismatch for $name" }
}
try {
  Write-Host 'Downloading verified Windows Executor assets...'
  $sumsPath = Download-ReleaseAsset 'SHA256SUMS'
  if ((Get-Item $sumsPath).Length -gt $maxMetadataBytes) { throw 'SHA256SUMS exceeds metadata size limit' }
  if ($publicRelease) {
    $bundlePath = Download-ReleaseAsset 'SHA256SUMS.sigstore.json'
    if ((Get-Item $bundlePath).Length -gt $maxMetadataBytes) { throw 'SHA256SUMS.sigstore.json exceeds metadata size limit' }
    $cosign = Get-Command cosign -ErrorAction SilentlyContinue
    if (-not $cosign) { throw 'cosign is required to verify public release signatures' }
    & $cosign.Source verify-blob --bundle $bundlePath --certificate-identity-regexp "^https://github.com/$repo/.github/workflows/release\\.yml@refs/tags/v" --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' $sumsPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'SHA256SUMS Sigstore verification failed' }
  }
  $sums = @(Get-Content $sumsPath)
  $binary = Download-ReleaseAsset $asset
  $archive = Download-ReleaseAsset $companion
  $serviceHostBinary = Download-ReleaseAsset $serviceHost
  Write-Host 'Verifying Windows Executor checksum...'
  Assert-Digest $binary (Read-ExpectedDigest $asset $sums) $asset
  Write-Host 'Verifying Windows ConPTY archive checksum...'
  Assert-Digest $archive (Read-ExpectedDigest $companion $sums) $companion
  Write-Host 'Verifying Windows service-host checksum...'
  Assert-Digest $serviceHostBinary (Read-ExpectedDigest $serviceHost $sums) $serviceHost
  Write-Host 'Verifying Windows ConPTY companion...'

  Write-Host 'Checking Windows ConPTY tar inventory...'
  $tar = Get-Command tar -ErrorAction SilentlyContinue
  if (-not $tar) { throw 'tar is required to install the ConPTY companion' }
  # Use a fixed relative name inside the download directory: Git for Windows
  # GNU tar otherwise interprets a drive-letter archive path as host:archive.
  Push-Location -LiteralPath $work
  try {
    $listed = @(& $tar.Source -tzf $companion | ForEach-Object { ($_ -replace '^\\./', '').TrimEnd([char]13) } | Where-Object { $_ })
    if ($LASTEXITCODE -ne 0) { throw "Failed to inspect $companion" }
    Write-Host 'Windows ConPTY tar listed.'
    $expectedEntries = @('node-pty-companion.json', 'win32-x64/', 'win32-x64/conpty.node', 'win32-x64/conpty_console_list.node', 'win32-x64/pty.node', 'win32-x64/winpty-agent.exe', 'win32-x64/winpty.dll', 'worker/', 'worker/conoutSocketWorker.js', 'shared/', 'shared/conout.js')
    if (@($listed).Count -ne $expectedEntries.Count -or @($listed | Sort-Object -Unique).Count -ne $expectedEntries.Count -or @(Compare-Object ($listed | Sort-Object) ($expectedEntries | Sort-Object)).Count -ne 0) { throw "$companion contains an unexpected file inventory" }
    Write-Host 'Windows ConPTY inventory verified.'
    & $tar.Source -xzf $companion
    if ($LASTEXITCODE -ne 0) { throw "Failed to extract $companion" }
    Write-Host 'Windows ConPTY extracted.'
  } finally { Pop-Location }

  Write-Host 'Checking Windows ConPTY manifest...'
  $manifest = Get-Content -Raw (Join-Path $work 'node-pty-companion.json') | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 1 -or $manifest.product -ne 'kala-executor-node-pty-companion' -or $manifest.target -ne 'win32-x64' -or [string]$manifest.nodePtyVersion -notmatch '^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw 'ConPTY companion manifest identity is invalid' }
  if (@($manifest.files).Count -ne 7) { throw 'ConPTY companion manifest file inventory is invalid' }
  $manifestPaths = @($manifest.files | ForEach-Object { [string]$_.path })
  $expectedManifestPaths = @('prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node', 'prebuilds/win32-x64/pty.node', 'prebuilds/win32-x64/winpty-agent.exe', 'prebuilds/win32-x64/winpty.dll', 'worker/conoutSocketWorker.js', 'shared/conout.js')
  if (@($manifestPaths).Count -ne $expectedManifestPaths.Count -or @($manifestPaths | Sort-Object -Unique).Count -ne $expectedManifestPaths.Count -or @(Compare-Object ($manifestPaths | Sort-Object) ($expectedManifestPaths | Sort-Object)).Count -ne 0) { throw 'ConPTY companion manifest file inventory is invalid' }
  Write-Host 'Hashing Windows ConPTY files...'
  foreach ($file in @($manifest.files)) {
    $runtimePath = [string]$file.path
    if ($runtimePath -notmatch '^(prebuilds/win32-x64/(conpty\\.node|conpty_console_list\\.node|pty\\.node|winpty-agent\\.exe|winpty\\.dll)|worker/conoutSocketWorker\\.js|shared/conout\\.js)$') { throw 'ConPTY companion manifest contains an invalid path' }
    if ([string]$file.sha256 -notmatch '^[0-9a-f]{64}$' -or [int64]$file.bytes -le 0) { throw 'ConPTY companion manifest file metadata is invalid' }
    $archivePath = if ($runtimePath.StartsWith('prebuilds/win32-x64/')) { $runtimePath.Substring('prebuilds/'.Length) } else { $runtimePath }
    $path = Join-Path $work ($archivePath -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -ne [int64]$file.bytes) { throw "ConPTY companion size mismatch for $runtimePath" }
    Assert-Digest $path ([string]$file.sha256) $runtimePath
  }
  Write-Host 'Windows ConPTY archive verified.'
  $prebuilds = Join-Path $work 'prebuilds'
  New-Item -ItemType Directory -Path $prebuilds -Force | Out-Null
  Move-Item (Join-Path $work 'win32-x64') (Join-Path $prebuilds 'win32-x64') -Force
  Write-Host 'Starting verified Windows Executor...'
  if ($hostRelease) { & $binary @args } else { & $binary --internal-installer @args }
  if ($LASTEXITCODE -ne 0) { throw "Executor installer exited with code $LASTEXITCODE" }
} finally {
  if (-not $env:KALA_INSTALLER_WORK_DIR) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
}
`
}

function githubReleaseBase(repo, tag) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('invalid release repo')
  if (!/^[A-Za-z0-9_.-]+$/.test(tag)) throw new Error('invalid release tag')
  return `https://github.com/${repo}/releases/${tag === 'latest' ? 'latest/download' : `download/${tag}`}`
}
