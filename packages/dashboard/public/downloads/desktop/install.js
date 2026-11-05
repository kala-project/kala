import { desktopBootstrapAvailable, desktopDownloadBase, desktopInstallCommands, desktopLocalInstallCommands, loadDesktopRelease } from './release-data.js'

document.getElementById('origin').textContent = location.origin
const release = document.getElementById('release')
try {
  const manifest = await loadDesktopRelease()
  document.getElementById('deb').href = `${desktopDownloadBase}${manifest.artifact.file}`
  document.getElementById('manifest').href = `${desktopDownloadBase}${manifest.dependencies.file}`
  document.getElementById('checksums').href = `${desktopDownloadBase}${manifest.checksums.file}`
  document.getElementById('version').textContent = `Version ${manifest.version} · Linux amd64 · ${(manifest.artifact.size / 1048576).toFixed(1)} MiB`
  if (await desktopBootstrapAvailable()) {
    document.getElementById('remote-install').hidden = false
  } else {
    document.getElementById('remote-unavailable').hidden = false
  }
  for (const [commandId, copyId, commands] of [
    ...(document.getElementById('remote-install').hidden ? [] : [['commands', 'deb-copy', desktopInstallCommands(manifest, location.origin)]]),
    ['local-commands', 'local-copy', desktopLocalInstallCommands(manifest)],
  ]) {
    document.getElementById(commandId).textContent = commands
    const copy = document.getElementById(copyId)
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(commands)
        copy.textContent = 'Copied'
      } catch {
        copy.textContent = 'Copy unavailable — select the full command below'
      }
    })
  }
  document.getElementById('available').hidden = false
  release.textContent = `Published package SHA-256: ${manifest.artifact.sha256}`
} catch (error) {
  release.textContent = error instanceof Error ? error.message : 'Desktop downloads are currently unavailable.'
}
