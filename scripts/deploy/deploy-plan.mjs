import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const EXTERNAL_RELEASE_ASSETS = Object.freeze([
  ...['kala-host', 'kala-executor', 'kala-dedicated-ingress', 'kala-dedicated-deploy-supervisor']
    .flatMap((name) => ['linux-x64', 'darwin-x64', 'darwin-arm64'].map((target) => `${name}-${target}`)),
  'kala-dashboard-with-runtime.cjs',
  'kala-runtime.cjs',
  'kala-executor.cjs',
  'kala-dedicated-ingress.cjs',
  'kala-dedicated-deploy-supervisor.cjs',
  'kala-dashboard.tar.gz',
  'kala-docs.tar.gz',
  'kala-dedicated-support.tar.gz',
  'kala-release-metadata.tar.gz',
  'run.sh',
  'kala-dedicated.mjs',
  'kala-model-catalog-seed.json',
  'manifest.json',
  'SHA256SUMS',
  'SHA256SUMS.sigstore.json',
])

export const DEPLOYABLE_RELEASE_ASSETS = EXTERNAL_RELEASE_ASSETS

export const REQUIRED_RELEASE_ASSETS = Object.freeze([
  'kala-dashboard-with-runtime.cjs',
  'kala-dedicated-ingress.cjs',
  'kala-dedicated-deploy-supervisor.cjs',
  'kala-executor.cjs',
  'SHA256SUMS',
])

export const RETIRED_RELEASE_ASSETS = Object.freeze([
  'agent-runlab-swebench-runner.cjs',
  'claude-code-swebench-runner.cjs',
])

const RESTART_MODES = new Set(['checkpoint', 'when_idle', 'force'])

export function buildDeployPlan({ args, env, root, now = new Date(), exists = existsSync, readDir = readdirSync }) {
  const releaseDir = join(root, 'release')
  const options = parseOptions(args)
  const sshTarget = requiredOption(options.ssh ?? env.KALA_DEPLOY_SSH, '--ssh or KALA_DEPLOY_SSH')
  const hostUrl = requiredOption(options.hostUrl ?? env.KALA_DEPLOY_HOST_URL, '--host-url or KALA_DEPLOY_HOST_URL')
  const remoteBin = requiredOption(options.remoteBin ?? env.KALA_DEPLOY_REMOTE_BIN, '--remote-bin or KALA_DEPLOY_REMOTE_BIN')
  const restartMode = options.restartMode ?? env.KALA_DEPLOY_RESTART_MODE ?? 'checkpoint'
  const restartTimeoutMs = positiveNumber(options.restartTimeoutMs ?? env.KALA_DEPLOY_RESTART_TIMEOUT_MS ?? 600000, '--restart-timeout-ms')
  const statusTimeoutMs = positiveNumber(options.statusTimeoutMs ?? env.KALA_DEPLOY_STATUS_TIMEOUT_MS ?? restartTimeoutMs + 60000, '--status-timeout-ms')
  const pollMs = positiveNumber(options.pollMs ?? env.KALA_DEPLOY_POLL_MS ?? 2000, '--poll-ms')
  const service = options.service ?? env.KALA_DEPLOY_SERVICE
  const sudo = options.sudo === true || /^(?:1|true|yes|on)$/iu.test(env.KALA_DEPLOY_SUDO ?? '')

  if (!RESTART_MODES.has(restartMode)) throw new Error('--restart-mode must be checkpoint, when_idle, or force')

  const files = releaseFiles(releaseDir, { exists, readDir })
  if (files.length === 0) {
    throw new Error(`no deployable release assets found in ${releaseDir}; run pnpm run build:release-assets first`)
  }
  for (const required of REQUIRED_RELEASE_ASSETS) {
    if (!files.includes(required)) {
      throw new Error(`release asset ${required} is missing from ${releaseDir}; run pnpm run build:release-assets first`)
    }
  }

  const stamp = deployStamp(now)
  const uploadDir = `${remoteBin.replace(/\/$/, '')}/.kala-upload-${stamp}`
  return {
    root,
    releaseDir,
    sshTarget,
    hostUrl: hostUrl.replace(/\/$/, ''),
    remoteBin,
    remoteBinShell: remotePathForShell(remoteBin),
    restartMode,
    restartTimeoutMs,
    statusTimeoutMs,
    pollMs,
    files,
    uploadDir,
    uploadDirShell: remotePathForShell(uploadDir),
    seedCommand: seedUploadScript(remoteBin, uploadDir, files),
    installCommand: installScript(remoteBin, uploadDir, files),
    rollbackCommand: rollbackScript(remoteBin, service, sudo),
    service,
    sudo,
  }
}

export function releaseFiles(releaseDir, { exists = existsSync, readDir = readdirSync } = {}) {
  if (!exists(releaseDir)) return []
  const wanted = new Set(DEPLOYABLE_RELEASE_ASSETS)
  return readDir(releaseDir)
    .filter((name) => wanted.has(name))
    .filter((name) => exists(join(releaseDir, name)))
    .sort()
}

export function installScript(remoteBinDir, remoteUploadDir, names, retiredNames = RETIRED_RELEASE_ASSETS) {
  const catalogSeed = 'kala-model-catalog-seed.json'
  const lines = [
    'set -euo pipefail',
    `REMOTE_BIN=${remotePathForShell(remoteBinDir)}`,
    `UPLOAD_DIR=${remotePathForShell(remoteUploadDir)}`,
    'BACKUP_DIR="$REMOTE_BIN/.kala-backup-$(date +%Y%m%d%H%M%S)"',
    'mkdir -p "$REMOTE_BIN" "$BACKUP_DIR"',
    'cd "$UPLOAD_DIR"',
    'sha256sum -c SHA256SUMS --ignore-missing',
    'MODEL_CATALOG_DIR="$HOME/.local/share/kala/model-catalog"',
  ]
  for (const name of names) {
    lines.push(`printf '%s\\n' ${sh(name)} >> "$BACKUP_DIR/.deployed-files"`)
    lines.push(`if [ -e "$REMOTE_BIN/${name}" ]; then cp -p "$REMOTE_BIN/${name}" "$BACKUP_DIR/${name}"; fi`)
  }
  for (const name of retiredNames) {
    lines.push(`printf '%s\\n' ${sh(name)} >> "$BACKUP_DIR/.deployed-files"`)
    lines.push(`if [ -e "$REMOTE_BIN/${name}" ]; then cp -p "$REMOTE_BIN/${name}" "$BACKUP_DIR/${name}"; fi`)
    lines.push(`rm -f "$REMOTE_BIN/${name}"`)
  }
  lines.push('printf "%s\\n" "$BACKUP_DIR" > "$REMOTE_BIN/.kala-backup-current"')
  for (const name of names) {
    lines.push(`mv "$UPLOAD_DIR/${name}" "$REMOTE_BIN/${name}"`)
  }
  if (names.includes(catalogSeed)) {
    lines.push('mkdir -p "$MODEL_CATALOG_DIR"')
    lines.push(`cp -p "$REMOTE_BIN/${catalogSeed}" "$MODEL_CATALOG_DIR/models-dev-seed.json"`)
  }
  for (const name of names.filter((name) => name.endsWith('.cjs') || name === 'run.sh')) {
    lines.push(`chmod +x "$REMOTE_BIN/${name}"`)
  }
  lines.push('rm -f "$REMOTE_BIN/.kala-upload-current"')
  lines.push('printf "%s\n" "$UPLOAD_DIR" > "$REMOTE_BIN/.kala-upload-current"')
  lines.push('rmdir "$UPLOAD_DIR" 2>/dev/null || true')
  return lines.join('\n')
}

export function rollbackScript(remoteBinDir, service, sudo = false) {
  return [
    'set -euo pipefail',
    `REMOTE_BIN=${remotePathForShell(remoteBinDir)}`,
    'BACKUP_DIR=$(cat "$REMOTE_BIN/.kala-backup-current")',
    '[ -d "$BACKUP_DIR" ]',
    '[ -f "$BACKUP_DIR/.deployed-files" ]',
    'while IFS= read -r name; do rm -f "$REMOTE_BIN/$name"; [ ! -e "$BACKUP_DIR/$name" ] || cp -p "$BACKUP_DIR/$name" "$REMOTE_BIN/$name"; done < "$BACKUP_DIR/.deployed-files"',
    ...(service ? [`${sudo ? 'sudo -n ' : ''}systemctl restart ${sh(service)}`] : []),
  ].join('\n')
}

export function seedUploadScript(remoteBinDir, remoteUploadDir, names) {
  const lines = [
    'set -euo pipefail',
    'command -v rsync >/dev/null || { echo "remote deploy requires rsync" >&2; exit 127; }',
    `REMOTE_BIN=${remotePathForShell(remoteBinDir)}`,
    `UPLOAD_DIR=${remotePathForShell(remoteUploadDir)}`,
    'mkdir -p "$REMOTE_BIN" "$UPLOAD_DIR"',
  ]
  for (const name of names) {
    lines.push(`if [ -f "$REMOTE_BIN/${name}" ]; then cp -p "$REMOTE_BIN/${name}" "$UPLOAD_DIR/${name}"; fi`)
  }
  return lines.join('\n')
}

export function rsyncUploadArgs({ releaseDir, files, sshTarget, uploadDir }) {
  return [
    '--archive',
    '--checksum',
    '--compress',
    '--no-whole-file',
    '--human-readable',
    '--partial',
    '--inplace',
    '--timeout=120',
    '--info=progress2,stats2',
    '--rsh=ssh -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3',
    ...files.map((file) => join(releaseDir, file)),
    `${sshTarget}:${uploadDir}/`,
  ]
}

export function parseOptions(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args
  return {
    ssh: optionValue(normalized, '--ssh'),
    hostUrl: optionValue(normalized, '--host-url'),
    remoteBin: optionValue(normalized, '--remote-bin'),
    restartMode: optionValue(normalized, '--restart-mode'),
    restartTimeoutMs: optionValue(normalized, '--restart-timeout-ms'),
    statusTimeoutMs: optionValue(normalized, '--status-timeout-ms'),
    pollMs: optionValue(normalized, '--poll-ms'),
    service: optionValue(normalized, '--service'),
    sudo: normalized.includes('--sudo'),
  }
}

export function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

export function remotePathForShell(value) {
  if (value === '~') return '"$HOME"'
  if (value.startsWith('~/')) return `"$HOME"/${sh(value.slice(2))}`
  return sh(value)
}

function deployStamp(now) {
  return now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
}

function requiredOption(value, name) {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`missing ${name}`)
  return trimmed
}

function positiveNumber(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`)
  return parsed
}

function optionValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === name) return args[i + 1]
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}
