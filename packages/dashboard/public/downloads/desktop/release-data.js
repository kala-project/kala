export const desktopDownloadBase = '/downloads/desktop/'

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export function validateDesktopRelease(manifest) {
  if (!record(manifest) || manifest.schemaVersion !== 2 || manifest.platform !== 'linux-amd64'
      || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:~[0-9A-Za-z.-]+)?$/.test(manifest.version)
      || !record(manifest.artifact) || typeof manifest.artifact.file !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._+~-]*\.deb$/.test(manifest.artifact.file)
      || !sha256(manifest.artifact.sha256)
      || !Number.isSafeInteger(manifest.artifact.size) || manifest.artifact.size <= 0) {
    throw new Error('Desktop release metadata is invalid. Downloads are disabled.')
  }
  const prefix = `${manifest.version}-${manifest.artifact.sha256}`
  if (!record(manifest.dependencies) || manifest.dependencies.file !== `${prefix}.dependencies.json`
      || !record(manifest.checksums) || manifest.checksums.file !== `${prefix}.SHA256SUMS.txt`
      || !sha256(manifest.dependencies.sha256) || !sha256(manifest.checksums.sha256)) {
    throw new Error('Immutable release metadata is invalid. Downloads are disabled.')
  }
  return {
    schemaVersion: 2, platform: 'linux-amd64', version: manifest.version,
    artifact: { file: manifest.artifact.file, sha256: manifest.artifact.sha256, size: manifest.artifact.size },
    dependencies: { file: manifest.dependencies.file, sha256: manifest.dependencies.sha256 },
    checksums: { file: manifest.checksums.file, sha256: manifest.checksums.sha256 },
  }
}

export async function loadDesktopRelease() {
  const response = await fetch(`${desktopDownloadBase}release.json`, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error('No packaged desktop release is published on this deployment yet.')
  const manifest = validateDesktopRelease(await response.json())
  const checks = await Promise.all([manifest.artifact.file, manifest.dependencies.file, manifest.checksums.file]
    .map((file) => fetch(`${desktopDownloadBase}${file}`, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(8000) })))
  if (checks.some((check) => !check.ok || check.headers.get('content-type')?.toLowerCase().includes('text/html'))) {
    throw new Error('Desktop release files are incomplete. Downloads are disabled.')
  }
  return manifest
}

export async function desktopBootstrapAvailable() {
  const responses = await Promise.all(['desktop-install.sh', 'desktop-package.deb', 'desktop-dependencies.json', 'desktop-SHA256SUMS.txt']
    .map((file) => fetch(`/install/assets/${file}`, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(8000) })))
  return responses.every((response) => response.ok && !response.headers.get('content-type')?.toLowerCase().includes('text/html'))
}

export function validateDesktopOrigin(origin) {
  if (typeof origin !== 'string' || !/^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(origin)) {
    throw new Error('Installation commands require a trusted HTTPS origin or explicit loopback HTTP origin.')
  }
  const parsed = new URL(origin)
  if (parsed.origin !== origin || (parsed.protocol !== 'https:'
      && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
    throw new Error('Installation commands require a trusted HTTPS origin or explicit loopback HTTP origin.')
  }
  return origin
}

export function desktopInstallCommands(input, origin) {
  validateDesktopRelease(input)
  const trustedOrigin = validateDesktopOrigin(origin)
  const protocol = trustedOrigin.startsWith('https:') ? '=https' : '=http,https'
  const installer = `${trustedOrigin}/install/assets/desktop-install.sh`
  return `bash -o pipefail -c "curl --proto '${protocol}' --tlsv1.2 --fail --show-error --silent --location '${installer}' | bash -s -- '${trustedOrigin}'" || { status=$?; printf '%s\\n' 'Kala Desktop installation failed. Check the error above. If the response was HTML or HTTP 302/403, Cloudflare Access must allow /install/assets/* for command-line downloads.' >&2; (exit "$status"); }`
}

export function desktopBootstrapScript(input) {
  const manifest = validateDesktopRelease(input)
  const files = [manifest.artifact, manifest.dependencies, manifest.checksums]
  const setup = `origin="\${1:-}"
case "$origin" in
  https://*|http://localhost:*|http://127.0.0.1:*|http://\\[::1\\]:*) ;;
  *) printf '%s\\n' 'A trusted HTTPS origin is required.' >&2; exit 1 ;;
esac
if ! command -v curl >/dev/null; then
  sudo apt-get -o APT::Update::Error-Mode=any update
  sudo apt-get install -y ca-certificates curl
fi`
  const publicNames = new Map([
    [manifest.artifact.file, 'desktop-package.deb'],
    [manifest.dependencies.file, 'desktop-dependencies.json'],
    [manifest.checksums.file, 'desktop-SHA256SUMS.txt'],
  ])
  const acquire = files.map(({ file }) => `curl --proto '=http,https' --tlsv1.2 --fail --show-error --silent \\
  --connect-timeout 15 --max-time 120 \\
  --output "$tmp/${file}" \\
  "$origin/install/assets/${publicNames.get(file)}"`).join('\n')
  return desktopInstallerScript(manifest, files, setup, acquire, true, false)
}

export function desktopLocalInstallCommands(input) {
  const manifest = validateDesktopRelease(input)
  const names = [...new Set([manifest.artifact.file, manifest.artifact.file.replaceAll('~', '_')])]
  const setup = `command -v install >/dev/null || { printf '%s\\n' 'Required tool missing: install' >&2; exit 1; }
source="\${KALA_DESKTOP_PACKAGE:-}"
if [ -z "$source" ]; then
  downloads="$HOME/Downloads"
  if command -v xdg-user-dir >/dev/null; then downloads="$(xdg-user-dir DOWNLOAD)"; fi
  case "$downloads" in /*) ;; *) printf '%s\\n' 'Invalid configured Downloads directory.' >&2; exit 1 ;; esac
  for candidate in ${names.map(name => `"$downloads/${name}"`).concat(names.map(name => `"./${name}"`)).join(' ')}; do
    if [ -f "$candidate" ]; then source="$candidate"; break; fi
  done
fi
if [ -z "$source" ] || [ ! -f "$source" ]; then
  printf '%s\\n' 'Downloaded package not found. Place it in Downloads or the current directory.' \\
    'For another filename/location, export KALA_DESKTOP_PACKAGE="/full/path/to/package.deb" and run this block again.' >&2
  exit 1
fi`
  return desktopInstallerScript(manifest, [manifest.artifact], setup,
    `install -m 600 -- "$source" "$tmp/${manifest.artifact.file}"`, false)
}

function desktopInstallerScript(manifest, files, setup, acquire, verifyList, heredoc = true) {
  const script = `# KALA_DESKTOP_INSTALLER_V1
set -euo pipefail
# Checksums detect corruption, not publisher identity. Trust this deployment.
# This unsigned .deb does not configure automatic updates.
for tool in sha256sum dpkg sudo mktemp chmod; do
  command -v "$tool" >/dev/null || { printf 'Required tool missing: %s\\n' "$tool" >&2; exit 1; }
done
if [ "$(dpkg --print-architecture)" != amd64 ]; then
  printf '%s\\n' 'This desktop package supports amd64 only.' >&2
  exit 1
fi
${setup}
# Keep downloads in a private temporary directory, removed on success or failure.
umask 077
tmp="$(mktemp -d /tmp/agent-runlab-install.XXXXXXXXXX)"
cleanup() {
  rm -f -- ${files.map(({ file }) => `"$tmp/${file}"`).join(' \\\n    ')}
  rmdir -- "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
${acquire}
cd -- "$tmp"
# Verify every exact named file before reading the immutable checksum list.
printf '%s\\n' \\
${files.map(({ file, sha256: digest }) => `  '${digest}  ${file}'`).join(' \\\n')} \\
  | sha256sum --strict --check -
${verifyList ? `sha256sum --strict --check '${manifest.checksums.file}'\n` : ''}# The original downloaded file and home-directory permissions remain unchanged.
# Let APT's unprivileged _apt user read only the verified public package.
chmod 644 -- "$tmp/${manifest.artifact.file}"
chmod 755 -- "$tmp"
sudo apt install -y -- "$tmp/${manifest.artifact.file}"`
  return heredoc ? `bash <<'KALA_DESKTOP_INSTALL'\n${script}\nKALA_DESKTOP_INSTALL` : script
}
