export type { DesktopRelease } from '../../public/downloads/desktop/release-data.js'

export const desktopDownloadBase = '/downloads/desktop/'

export async function loadDesktopUpdateMetadata() {
  const data: typeof import('../../public/downloads/desktop/release-data.js') =
    await import(/* @vite-ignore */ `${desktopDownloadBase}release-data.js?metadata=${Date.now()}`)
  const response = await fetch(`${desktopDownloadBase}release.json`, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
  if (!response.ok) throw new Error(`Desktop release metadata: HTTP ${response.status}`)
  return data.validateDesktopRelease(await response.json())
}

// Load the same browser modules as the backwards-compatible standalone page.
export async function loadDesktopDownload() {
  const data: typeof import('../../public/downloads/desktop/release-data.js') =
    await import(/* @vite-ignore */ `${desktopDownloadBase}release-data.js?metadata=${Date.now()}`)
  const release = await data.loadDesktopRelease()
  const commands = await data.desktopBootstrapAvailable()
    ? data.desktopInstallCommands(release, window.location.origin)
    : null
  return { release, commands, localCommands: data.desktopLocalInstallCommands(release) }
}

export async function loadDesktopApt(): Promise<string | null> {
  const response = await fetch(`${desktopDownloadBase}apt-install.json`, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Could not load approved APT installation settings.')
  const data: typeof import('../../public/downloads/desktop/apt-snippet.js') =
    await import(/* @vite-ignore */ `${desktopDownloadBase}apt-snippet.js`)
  return data.aptInstallSnippet(await response.json())
}
