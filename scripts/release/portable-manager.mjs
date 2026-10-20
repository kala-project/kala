const HOST_ASSET = 'kala-dashboard-with-runtime.cjs'

export const POSIX_PORTABLE_MANAGER = 'kala-portable.sh'
export const WINDOWS_PORTABLE_MANAGER = 'kala-portable.ps1'

export function generatePosixPortableManager({ repo, tag }) {
  assertReleaseIdentity(repo, tag)
  return `#!/usr/bin/env bash
set -euo pipefail

REPO=${shellQuote(repo)}
BUILT_TAG=${shellQuote(tag)}
ASSET=${shellQuote(HOST_ASSET)}
MANAGER_ASSET=${shellQuote(POSIX_PORTABLE_MANAGER)}
CLEANUP_DIR=''
cleanup() { [ -z "$CLEANUP_DIR" ] || rm -rf -- "$CLEANUP_DIR"; }
trap cleanup EXIT

platform_defaults() {
  case "$(uname -s)" in
    Linux)  DEFAULT_ROOT="\${XDG_DATA_HOME:-$HOME/.local/share}/kala-portable"; DEFAULT_DATA="\${XDG_STATE_HOME:-$HOME/.local/state}/kala" ;;
    Darwin) DEFAULT_ROOT="$HOME/Library/Application Support/Kala Portable"; DEFAULT_DATA="$HOME/Library/Application Support/Kala" ;;
    *) echo "Kala Portable supports Linux and macOS through this entry point." >&2; exit 1 ;;
  esac
}
platform_defaults
case "$(uname -m)" in x86_64|amd64) ;; *) die_arch="$(uname -m)"; echo "Kala Portable management is released for x64, not $die_arch." >&2; exit 1 ;; esac
ROOT="\${KALA_PORTABLE_HOME:-$DEFAULT_ROOT}"
DATA="\${KALA_PORTABLE_DATA_DIR:-$DEFAULT_DATA}"
RUNTIME="$ROOT/runtime"
PID_FILE="$ROOT/kala.pid"
LOG_FILE="$ROOT/kala.log"
TAG_FILE="$ROOT/release-tag"
BASE_FILE="$ROOT/release-base-url"
MANAGER="$ROOT/bin/kala-portable"

usage() {
  cat <<'EOF'
Usage: kala-portable <install|start|status|logs|stop|upgrade|uninstall> [options]
  install                 Verify and install the manager's release; does not start it
  start                   Start a background per-user process
  status                  Report running/stopped and installed release
  logs [-f]               Show the latest log output, optionally follow it
  stop                    Stop the managed process after verifying its identity
  upgrade [--tag TAG]     Fetch and verify TAG (default: latest), then atomically activate
  uninstall [--purge-data] Stop and remove the app; data is retained by default

Environment: KALA_PORTABLE_HOME, KALA_PORTABLE_DATA_DIR, KALA_PORTABLE_BIND
(default 127.0.0.1), KALA_PORTABLE_PORT (default 3000), KALA_RELEASE_BASE_URL.
EOF
}

die() { echo "Kala Portable: $*" >&2; exit 1; }
require() { command -v "$1" >/dev/null 2>&1 || die "required command '$1' was not found"; }
classify_url() {
  node - "$1" <<'NODE'
const input = process.argv[2]
let url
try { url = new URL(input) } catch { process.exit(2) }
if (url.username || url.password || (url.protocol !== 'https:' && url.protocol !== 'http:')) process.exit(2)
if (url.protocol === 'http:') {
  const host = url.hostname.toLowerCase()
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]') process.exit(2)
  process.stdout.write('loopback')
} else {
  process.stdout.write('secure')
}
NODE
}
validate_base() { local kind; kind="$(classify_url "$1" 2>/dev/null)" || die "release URL must be a valid credential-free HTTPS URL (HTTP is allowed only for exact loopback hosts)"; printf '%s' "$kind"; }
is_loopback_url() { [ "$(validate_base "$1")" = loopback ]; }
default_base() { if [ "$1" = latest ]; then printf 'https://github.com/%s/releases/latest/download' "$REPO"; else printf 'https://github.com/%s/releases/download/%s' "$REPO" "$1"; fi; }
installed_tag() { [ -f "$TAG_FILE" ] && cat "$TAG_FILE" || printf '%s' "$BUILT_TAG"; }
selected_base() { local selected_tag="$1"; if [ -n "\${KALA_RELEASE_BASE_URL:-}" ]; then printf '%s' "\${KALA_RELEASE_BASE_URL%/}"; else default_base "$selected_tag"; fi; }

assert_safe_paths() {
  local output
  output="$(node - "$ROOT" "$DATA" "$HOME" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const [rootInput, dataInput, homeInput] = process.argv.slice(2)
const canonical = input => {
  let current = path.resolve(input)
  const suffix = []
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    suffix.unshift(path.basename(current)); current = parent
  }
  return path.resolve(fs.realpathSync.native(current), ...suffix)
}
const root = canonical(rootInput)
const data = canonical(dataInput)
const home = canonical(homeInput)
const key = value => process.platform === 'win32' ? value.toLowerCase() : value
const isFsRoot = value => key(value) === key(path.parse(value).root)
const contains = (parent, child) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}
if (isFsRoot(root) || isFsRoot(data) || key(root) === key(home) || key(data) === key(home)) {
  console.error('runtime and data directories must not be a filesystem root or the user home')
  process.exit(1)
}
if (contains(root, data) || contains(data, root)) {
  console.error('runtime and data directories must not overlap')
  process.exit(1)
}
process.stdout.write(root + '\\n' + data)
NODE
)" || die "unsafe Portable paths: $output"
  ROOT="\${output%%$'\n'*}"; DATA="\${output#*$'\n'}"
  RUNTIME="$ROOT/runtime"; PID_FILE="$ROOT/kala.pid"; LOG_FILE="$ROOT/kala.log"
  TAG_FILE="$ROOT/release-tag"; BASE_FILE="$ROOT/release-base-url"; MANAGER="$ROOT/bin/kala-portable"
}

fetch() { wget -q --tries=3 --timeout=30 --retry-connrefused -O "$2" "$1" || die "download failed: $1"; }
sha256_file() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else require sha256sum; sha256sum "$1" | awk '{print $1}'; fi; }
verify_index() {
  local base="$1" dir="$2"
  fetch "$base/SHA256SUMS" "$dir/SHA256SUMS"
  if ! is_loopback_url "$base"; then
    require cosign
    fetch "$base/SHA256SUMS.sigstore.json" "$dir/SHA256SUMS.sigstore.json"
    cosign verify-blob --bundle "$dir/SHA256SUMS.sigstore.json" --certificate-identity-regexp "^https://github.com/$REPO/.github/workflows/release\\.yml@refs/tags/v" --certificate-oidc-issuer https://token.actions.githubusercontent.com "$dir/SHA256SUMS" >/dev/null || die "release signature verification failed"
  fi
}
verify_asset() {
  local base="$1" dir="$2" name="$3" expected actual
  expected="$(awk -v file="$name" '$2 == file {print $1}' "$dir/SHA256SUMS")"
  [ -n "$expected" ] || die "$name is absent from SHA256SUMS"
  [ "$(printf '%s\n' "$expected" | wc -l | tr -d ' ')" = 1 ] || die "$name appears more than once in SHA256SUMS"
  fetch "$base/$name" "$dir/$name"
  actual="$(sha256_file "$dir/$name")"; [ "$actual" = "$expected" ] || die "$name checksum mismatch"
}
PREPARED_TAG=''; PREPARED_BASE=''; PREPARED_DIR=''
prepare_release() {
  local selected_tag="$1" base
  require wget; require node
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1 || die 'Node.js 22 or newer is required'
  base="$(selected_base "$selected_tag")"; validate_base "$base" >/dev/null
  mkdir -p "$ROOT"
  CLEANUP_DIR="$(mktemp -d "$ROOT/.upgrade.XXXXXX")"; PREPARED_DIR="$CLEANUP_DIR"
  verify_index "$base" "$PREPARED_DIR"
  verify_asset "$base" "$PREPARED_DIR" "$ASSET"
  verify_asset "$base" "$PREPARED_DIR" "$MANAGER_ASSET"
  chmod 0755 "$PREPARED_DIR/$ASSET" "$PREPARED_DIR/$MANAGER_ASSET"
  PREPARED_TAG="$selected_tag"; PREPARED_BASE="$base"
}
activate_prepared() {
  mkdir -p "$RUNTIME" "$DATA" "$ROOT/bin"
  cp "$PREPARED_DIR/$ASSET" "$RUNTIME/$ASSET.new" || return 1
  cp "$PREPARED_DIR/$MANAGER_ASSET" "$MANAGER.new" || return 1
  chmod 0755 "$RUNTIME/$ASSET.new" "$MANAGER.new" || return 1
  mv -f "$RUNTIME/$ASSET.new" "$RUNTIME/$ASSET" || return 1
  mv -f "$MANAGER.new" "$MANAGER" || return 1
  printf '%s\n' "$PREPARED_TAG" > "$TAG_FILE.new" || return 1
  printf '%s\n' "$PREPARED_BASE" > "$BASE_FILE.new" || return 1
  mv -f "$TAG_FILE.new" "$TAG_FILE" || return 1
  mv -f "$BASE_FILE.new" "$BASE_FILE" || return 1
}
snapshot_install() {
  mkdir -p "$PREPARED_DIR/rollback"
  for item in "$RUNTIME/$ASSET" "$MANAGER" "$TAG_FILE" "$BASE_FILE"; do
    if [ -f "$item" ]; then cp -p "$item" "$PREPARED_DIR/rollback/$(basename "$item")"; fi
  done
}
restore_install() {
  local backup="$PREPARED_DIR/rollback"
  if [ -f "$backup/$ASSET" ]; then mkdir -p "$RUNTIME"; cp -p "$backup/$ASSET" "$RUNTIME/$ASSET"; else rm -f "$RUNTIME/$ASSET"; fi
  if [ -f "$backup/$(basename "$MANAGER")" ]; then mkdir -p "$ROOT/bin"; cp -p "$backup/$(basename "$MANAGER")" "$MANAGER"; else rm -f "$MANAGER"; fi
  if [ -f "$backup/$(basename "$TAG_FILE")" ]; then cp -p "$backup/$(basename "$TAG_FILE")" "$TAG_FILE"; else rm -f "$TAG_FILE"; fi
  if [ -f "$backup/$(basename "$BASE_FILE")" ]; then cp -p "$backup/$(basename "$BASE_FILE")" "$BASE_FILE"; else rm -f "$BASE_FILE"; fi
}
install_release() {
  prepare_release "$1"; snapshot_install
  if ! activate_prepared; then restore_install; die 'activation failed; the previous installation was restored'; fi
  echo "Kala Portable $PREPARED_TAG installed in $ROOT"
  echo "Data directory: $DATA (retained by uninstall unless --purge-data is used)"
}

read_pid_record() {
  [ -f "$PID_FILE" ] || return 1
  local record; record="$(cat "$PID_FILE")"
  [[ "$record" =~ ^[1-9][0-9]*\\|.+$ ]] || return 2
  printf '%s' "$record"
}
process_fingerprint() { ps -o lstart= -o command= -p "$1" 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
is_running() {
  local record pid expected actual rc
  if record="$(read_pid_record)"; then :; else rc=$?; [ "$rc" = 1 ] && return 1; die 'PID file is malformed; refusing to inspect or signal a process'; fi
  pid="\${record%%|*}"; expected="\${record#*|}"
  kill -0 "$pid" 2>/dev/null || return 1
  actual="$(process_fingerprint "$pid")"; [ -n "$actual" ] && [ "$actual" = "$expected" ]
}
start() {
  [ -f "$RUNTIME/$ASSET" ] || die "not installed; run install first"
  if is_running; then echo "Kala Portable is already running (pid \${record_pid:-$(read_pid_record | cut -d'|' -f1)})"; return; fi
  rm -f "$PID_FILE"; mkdir -p "$DATA/sessions" "$DATA/artifacts" "$DATA/audit"
  local bind="\${KALA_PORTABLE_BIND:-127.0.0.1}" port="\${KALA_PORTABLE_PORT:-3000}" pid fingerprint
  KALA_BIND_HOST="$bind" KALA_PORT="$port" KALA_SESSIONS_DIR="$DATA/sessions" KALA_ARTIFACTS_DIR="$DATA/artifacts" KALA_AUDIT_DIR="$DATA/audit" KALA_EXECUTOR_IDENTITIES="$DATA/executor-identities.json" KALA_RELEASE_TAG="$(installed_tag)" KALA_UPDATE_REPO="$REPO" nohup node "$RUNTIME/$ASSET" >>"$LOG_FILE" 2>&1 </dev/null &
  pid="$!"; sleep 1
  kill -0 "$pid" 2>/dev/null || { rm -f "$PID_FILE"; die "process exited during startup; inspect $LOG_FILE"; }
  fingerprint="$(process_fingerprint "$pid")"; [ -n "$fingerprint" ] || { kill "$pid" 2>/dev/null || true; die 'could not establish managed process identity'; }
  printf '%s|%s\n' "$pid" "$fingerprint" > "$PID_FILE"
  echo "Kala Portable started (pid $pid, http://$bind:$port)"
}
status() {
  if is_running; then local record; record="$(read_pid_record)"; echo "running pid=\${record%%|*} tag=$(installed_tag)"
  else [ -f "$PID_FILE" ] && rm -f "$PID_FILE"; if [ -f "$RUNTIME/$ASSET" ]; then echo "stopped tag=$(installed_tag)"; else echo "not installed"; fi; return 3; fi
}
logs() { [ -f "$LOG_FILE" ] || die "no logs exist yet"; if [ "\${1:-}" = -f ]; then tail -f "$LOG_FILE"; elif [ "$#" -eq 0 ]; then tail -n 200 "$LOG_FILE"; else die 'logs accepts only -f'; fi; }
stop() {
  if ! is_running; then rm -f "$PID_FILE"; echo 'Kala Portable is stopped'; return; fi
  local record pid count=0; record="$(read_pid_record)"; pid="\${record%%|*}"
  is_running || die 'managed process identity changed; refusing to signal it'
  kill "$pid"
  while is_running && [ "$count" -lt 50 ]; do sleep .1; count=$((count + 1)); done
  if is_running; then is_running || die 'managed process identity changed; refusing to force it'; kill -KILL "$pid"; fi
  rm -f "$PID_FILE"; echo 'Kala Portable stopped'
}
valid_tag() { case "$1" in *[!A-Za-z0-9._-]*|'') return 1 ;; *) return 0 ;; esac; }
upgrade() {
  local next=latest was=0
  if [ "\${1:-}" = --tag ]; then [ "$#" -eq 2 ] || die 'upgrade --tag requires one value'; next="$2"; elif [ "$#" -ne 0 ]; then die 'upgrade accepts only --tag TAG'; fi
  valid_tag "$next" || die 'invalid release tag'
  prepare_release "$next"
  is_running && was=1
  snapshot_install
  [ "$was" = 0 ] || stop
  if ! activate_prepared; then restore_install; [ "$was" = 0 ] || (start || true); die 'upgrade activation failed; the previous installation was restored'; fi
  if [ "$was" = 1 ] && ! (start); then
    restore_install
    if ! (start); then die 'upgrade failed and the previous runtime was restored but could not be restarted'; fi
    die 'upgraded runtime failed to start; the previous runtime was restored and restarted'
  fi
  echo "Kala Portable upgraded to $PREPARED_TAG"
}
uninstall() {
  local purge=0
  if [ "\${1:-}" = --purge-data ]; then purge=1; elif [ "$#" -ne 0 ]; then die 'uninstall accepts only --purge-data'; fi
  stop
  rm -rf -- "$ROOT"
  if [ "$purge" = 1 ]; then rm -rf -- "$DATA"; echo 'Kala Portable and its data were removed'; else echo "Kala Portable removed; data retained in $DATA"; fi
}

require node
assert_safe_paths
command="\${1:-}"; [ -n "$command" ] || { usage; exit 2; }; shift
case "$command" in
  install) [ "$#" -eq 0 ] || die 'install takes no arguments'; install_release "$BUILT_TAG" ;;
  start) [ "$#" -eq 0 ] || die 'start takes no arguments'; start ;;
  status) [ "$#" -eq 0 ] || die 'status takes no arguments'; status ;;
  logs) logs "$@" ;;
  stop) [ "$#" -eq 0 ] || die 'stop takes no arguments'; stop ;;
  upgrade) upgrade "$@" ;;
  uninstall) uninstall "$@" ;;
  -h|--help|help) usage ;;
  *) usage >&2; die "unknown command: $command" ;;
esac
`
}

export function generateWindowsPortableManager({ repo, tag }) {
  assertReleaseIdentity(repo, tag)
  return `#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Position=0)][ValidateSet('install','start','status','logs','stop','upgrade','uninstall','help')][string]$Command = 'help',
  [string]$Tag,
  [switch]$Follow,
  [switch]$PurgeData
)
$ErrorActionPreference = 'Stop'
$Repo = ${psQuote(repo)}
$BuiltTag = ${psQuote(tag)}
$Asset = ${psQuote(HOST_ASSET)}
$ManagerAsset = ${psQuote(WINDOWS_PORTABLE_MANAGER)}
$Root = if ($env:KALA_PORTABLE_HOME) { $env:KALA_PORTABLE_HOME } else { Join-Path $env:LOCALAPPDATA 'Kala\Portable' }
$Data = if ($env:KALA_PORTABLE_DATA_DIR) { $env:KALA_PORTABLE_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'Kala\Data' }
$Runtime = Join-Path $Root 'runtime'
$PidFile = Join-Path $Root 'kala.pid'
$LogFile = Join-Path $Root 'kala.log'
$ErrorLog = Join-Path $Root 'kala-error.log'
$TagFile = Join-Path $Root 'release-tag'
$BaseFile = Join-Path $Root 'release-base-url'
$Manager = Join-Path $Root 'bin\kala-portable.ps1'

function Show-Usage { @'
Usage: .\kala-portable.ps1 <install|start|status|logs|stop|upgrade|uninstall>
  install                   Verify and install; does not start
  start                     Start a background per-user process
  status                    Report running/stopped and installed release
  logs [-Follow]            Show logs
  stop                      Refuses while running; safe cooperative shutdown is unavailable
  upgrade [-Tag TAG]        Default latest; running instances are refused
  uninstall [-PurgeData]    Retain data by default; refuses while running

This is a per-user process manager, not a Windows Service installer. Node.js 22+
is required. Automatic Windows stop is intentionally unavailable rather than
using Stop-Process, which cannot provide a safe cooperative shutdown here.
'@ }
function Fail([string]$Message) { throw "Kala Portable: $Message" }
function Assert-SafePaths {
  $script:Root = [IO.Path]::GetFullPath($script:Root); $script:Data = [IO.Path]::GetFullPath($script:Data)
  $home = [IO.Path]::GetFullPath($env:USERPROFILE); $comparison = [StringComparison]::OrdinalIgnoreCase
  function Is-Root([string]$Path) { return $Path.Equals([IO.Path]::GetPathRoot($Path), $comparison) }
  function Contains-Path([string]$Parent, [string]$Child) { $prefix = $Parent.TrimEnd('\') + '\'; return $Child.Equals($Parent, $comparison) -or $Child.StartsWith($prefix, $comparison) }
  if ((Is-Root $Root) -or (Is-Root $Data) -or $Root.Equals($home,$comparison) -or $Data.Equals($home,$comparison)) { Fail 'runtime and data directories must not be a drive root or the user home' }
  if ((Contains-Path $Root $Data) -or (Contains-Path $Data $Root)) { Fail 'runtime and data directories must not overlap' }
  $script:Runtime = Join-Path $Root 'runtime'; $script:PidFile = Join-Path $Root 'kala.pid'; $script:LogFile = Join-Path $Root 'kala.log'; $script:ErrorLog = Join-Path $Root 'kala-error.log'; $script:TagFile = Join-Path $Root 'release-tag'; $script:BaseFile = Join-Path $Root 'release-base-url'; $script:Manager = Join-Path $Root 'bin\kala-portable.ps1'
}
function Get-UrlKind([string]$Value) {
  $uri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or -not [string]::IsNullOrEmpty($uri.UserInfo)) { Fail 'release URL must be a valid credential-free HTTPS URL (HTTP is allowed only for exact loopback hosts)' }
  if ($uri.Scheme -eq 'https') { return 'secure' }
  if ($uri.Scheme -eq 'http' -and @('localhost','127.0.0.1','::1') -contains $uri.Host.ToLowerInvariant()) { return 'loopback' }
  Fail 'release URL must be a valid credential-free HTTPS URL (HTTP is allowed only for exact loopback hosts)'
}
function Get-Base([string]$ReleaseTag) {
  if ($env:KALA_RELEASE_BASE_URL) { return $env:KALA_RELEASE_BASE_URL.TrimEnd('/') }
  if ($ReleaseTag -eq 'latest') { return "https://github.com/$Repo/releases/latest/download" }
  return "https://github.com/$Repo/releases/download/$ReleaseTag"
}
function Download([string]$Url, [string]$Path) { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Path }
function Assert-Node22 {
  $node = Get-Command node -ErrorAction SilentlyContinue; if (-not $node) { Fail 'Node.js 22 or newer is required' }
  $major = & $node.Source -e "process.stdout.write(process.versions.node.split('.')[0])"; if ([int]$major -lt 22) { Fail 'Node.js 22 or newer is required' }
  $architecture = & $node.Source -p "process.arch"; if ($architecture -ne 'x64') { Fail "Windows Portable management is released for x64, not $architecture" }
  return $node.Source
}
function Prepare-Release([string]$ReleaseTag) {
  $nodePath = Assert-Node22; $base = Get-Base $ReleaseTag; $kind = Get-UrlKind $base
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  $temp = Join-Path $Root ('.upgrade.' + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory $temp | Out-Null
  try {
    $index = Join-Path $temp 'SHA256SUMS'; Download "$base/SHA256SUMS" $index
    if ($kind -ne 'loopback') {
      if (-not (Get-Command cosign -ErrorAction SilentlyContinue)) { Fail "required command 'cosign' was not found" }
      $bundle = Join-Path $temp 'SHA256SUMS.sigstore.json'; Download "$base/SHA256SUMS.sigstore.json" $bundle
      & cosign verify-blob --bundle "$bundle" --certificate-identity-regexp "^https://github.com/$Repo/.github/workflows/release\.yml@refs/tags/v" --certificate-oidc-issuer https://token.actions.githubusercontent.com "$index" | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail 'release signature verification failed' }
    }
    foreach ($name in @($Asset,$ManagerAsset)) {
      $lines = @(Get-Content $index | Where-Object { $_ -match ('^[0-9a-f]{64}  ' + [regex]::Escape($name) + '$') })
      if ($lines.Count -ne 1) { Fail "$name must appear exactly once in SHA256SUMS" }
      $downloaded = Join-Path $temp $name; Download "$base/$name" $downloaded
      $actual = (Get-FileHash -Algorithm SHA256 "$downloaded").Hash.ToLowerInvariant(); if ($actual -ne $lines[0].Substring(0,64)) { Fail "$name checksum mismatch" }
    }
    return @{ Tag=$ReleaseTag; Base=$base; Temp=$temp; NodePath=$nodePath }
  } catch { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue; throw }
}
function Activate-Release($Prepared) {
  New-Item -ItemType Directory -Force -Path $Runtime,$Data,(Join-Path $Root 'bin') | Out-Null
  Copy-Item -LiteralPath (Join-Path $Prepared.Temp $Asset) -Destination "$Runtime\$Asset.new" -Force
  Copy-Item -LiteralPath (Join-Path $Prepared.Temp $ManagerAsset) -Destination "$Manager.new" -Force
  Move-Item -LiteralPath "$Runtime\$Asset.new" -Destination (Join-Path $Runtime $Asset) -Force
  Move-Item -LiteralPath "$Manager.new" -Destination $Manager -Force
  Set-Content -NoNewline -LiteralPath $TagFile -Value $Prepared.Tag; Set-Content -NoNewline -LiteralPath $BaseFile -Value $Prepared.Base
}
function Backup-Installation($Prepared) {
  $backup = Join-Path $Prepared.Temp 'rollback'; New-Item -ItemType Directory -Force -Path $backup | Out-Null
  foreach ($path in @((Join-Path $Runtime $Asset),$Manager,$TagFile,$BaseFile)) {
    if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination (Join-Path $backup ([IO.Path]::GetFileName($path))) -Force }
  }
}
function Restore-Installation($Prepared) {
  $backup = Join-Path $Prepared.Temp 'rollback'
  function Restore-One([string]$Destination, [string]$Name) {
    $saved = Join-Path $backup $Name
    if (Test-Path -LiteralPath $saved) { New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($Destination)) | Out-Null; Copy-Item -LiteralPath $saved -Destination $Destination -Force }
    else { Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue }
  }
  Restore-One (Join-Path $Runtime $Asset) $Asset
  Restore-One $Manager ([IO.Path]::GetFileName($Manager))
  Restore-One $TagFile ([IO.Path]::GetFileName($TagFile))
  Restore-One $BaseFile ([IO.Path]::GetFileName($BaseFile))
}
function Get-ManagedProcess {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  try { $identity = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json } catch { Fail 'PID file is malformed; refusing to inspect a process' }
  [long]$managedId = 0; [long]$startTicks = 0
  if (-not [long]::TryParse([string]$identity.Id,[ref]$managedId) -or $managedId -le 0 -or -not [long]::TryParse([string]$identity.StartTimeUtcTicks,[ref]$startTicks) -or $startTicks -le 0 -or [string]::IsNullOrWhiteSpace($identity.NodePath)) { Fail 'PID file is malformed; refusing to inspect a process' }
  $process = Get-Process -Id $managedId -ErrorAction SilentlyContinue; if (-not $process) { return $null }
  if ($process.StartTime.ToUniversalTime().Ticks -ne $startTicks -or -not $process.Path.Equals($identity.NodePath,[StringComparison]::OrdinalIgnoreCase)) { return $null }
  return $process
}
function Start-Kala {
  $program = Join-Path $Runtime $Asset; if (-not (Test-Path -LiteralPath $program)) { Fail 'not installed; run install first' }
  $existing = Get-ManagedProcess; if ($existing) { Write-Output "Kala Portable is already running (pid $($existing.Id))"; return }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Join-Path $Data 'sessions'),(Join-Path $Data 'artifacts'),(Join-Path $Data 'audit') | Out-Null
  $env:KALA_BIND_HOST = if ($env:KALA_PORTABLE_BIND) { $env:KALA_PORTABLE_BIND } else { '127.0.0.1' }; $env:KALA_PORT = if ($env:KALA_PORTABLE_PORT) { $env:KALA_PORTABLE_PORT } else { '3000' }
  $env:KALA_SESSIONS_DIR = Join-Path $Data 'sessions'; $env:KALA_ARTIFACTS_DIR = Join-Path $Data 'artifacts'; $env:KALA_AUDIT_DIR = Join-Path $Data 'audit'; $env:KALA_EXECUTOR_IDENTITIES = Join-Path $Data 'executor-identities.json'; $env:KALA_RELEASE_TAG = Get-Content -LiteralPath $TagFile -Raw; $env:KALA_UPDATE_REPO = $Repo
  $nodePath = (Get-Command node).Source; $quotedProgram = '"' + $program.Replace('"','\"') + '"'
  $process = Start-Process -FilePath "$nodePath" -ArgumentList @($quotedProgram) -WindowStyle Hidden -RedirectStandardOutput "$LogFile" -RedirectStandardError "$ErrorLog" -PassThru
  $identity = @{ Id=[long]$process.Id; StartTimeUtcTicks=[long]$process.StartTime.ToUniversalTime().Ticks; NodePath=[string]$process.Path } | ConvertTo-Json -Compress
  Set-Content -NoNewline -LiteralPath $PidFile -Value $identity; Start-Sleep -Seconds 1
  if (-not (Get-ManagedProcess)) { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue; Fail "process exited during startup; inspect $LogFile and $ErrorLog" }
  Write-Output "Kala Portable started (pid $($process.Id), http://$($env:KALA_BIND_HOST):$($env:KALA_PORT))"
}
function Stop-Kala {
  $process = Get-ManagedProcess
  if (-not $process) { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue; Write-Output 'Kala Portable is stopped'; return }
  Fail 'safe cooperative shutdown is unavailable on Windows; stop the Kala process from its console before retrying'
}
function Install-Release([string]$ReleaseTag) {
  $prepared = Prepare-Release $ReleaseTag
  try {
    Backup-Installation $prepared
    try { Activate-Release $prepared }
    catch { Restore-Installation $prepared; throw "upgrade activation failed; the previous installation was restored: $_" }
    Write-Output "Kala Portable $ReleaseTag installed in $Root"; Write-Output "Data directory: $Data (retained by uninstall unless -PurgeData is used)"
  } finally { Remove-Item -LiteralPath $prepared.Temp -Recurse -Force -ErrorAction SilentlyContinue }
}

Assert-SafePaths
switch ($Command) {
  'install' { Install-Release $BuiltTag }
  'start' { Start-Kala }
  'status' { $p = Get-ManagedProcess; if ($p) { Write-Output "running pid=$($p.Id) tag=$(Get-Content -LiteralPath $TagFile -Raw)" } elseif (Test-Path -LiteralPath (Join-Path $Runtime $Asset)) { Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue; Write-Output "stopped tag=$(Get-Content -LiteralPath $TagFile -Raw)"; exit 3 } else { Write-Output 'not installed'; exit 3 } }
  'logs' { $paths = @($LogFile,$ErrorLog) | Where-Object { Test-Path -LiteralPath $_ }; if ($paths.Count -eq 0) { Fail 'no logs exist yet' }; Get-Content -LiteralPath $paths -Tail 200 -Wait:$Follow }
  'stop' { Stop-Kala }
  'upgrade' {
    $next = if ($Tag) { $Tag } else { 'latest' }; if ($next -notmatch '^[A-Za-z0-9._-]+$') { Fail 'invalid release tag' }
    if (Get-ManagedProcess) { Fail 'automatic upgrade is unavailable while running on Windows because safe cooperative shutdown is unavailable' }
    Install-Release $next
  }
  'uninstall' { if (Get-ManagedProcess) { Fail 'automatic uninstall is unavailable while running on Windows because safe cooperative shutdown is unavailable' }; Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue; if ($PurgeData) { Remove-Item -LiteralPath $Data -Recurse -Force -ErrorAction SilentlyContinue; Write-Output 'Kala Portable and its data were removed' } else { Write-Output "Kala Portable removed; data retained in $Data" } }
  default { Show-Usage }
}
`
}

function assertReleaseIdentity(repo, tag) {
  if (!/^[^/\s]+\/[^/\s]+$/u.test(repo)) throw new Error('portable manager repo must be owner/name')
  if (!/^[A-Za-z0-9._-]+$/u.test(tag)) throw new Error('portable manager tag is invalid')
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function psQuote(value) {
  return `'${value.replaceAll("'", "''")}'`
}
