export interface DesktopRelease {
  schemaVersion: 2
  platform: 'linux-amd64'
  version: string
  artifact: { file: string; sha256: string; size: number }
  dependencies: { file: string; sha256: string }
  checksums: { file: string; sha256: string }
}
export const desktopDownloadBase: '/downloads/desktop/'
export function validateDesktopRelease(manifest: unknown): DesktopRelease
export function loadDesktopRelease(): Promise<DesktopRelease>
export function desktopBootstrapAvailable(): Promise<boolean>
export function validateDesktopOrigin(origin: unknown): string
export function desktopInstallCommands(manifest: unknown, origin: string): string
export function desktopBootstrapScript(manifest: unknown): string
export function desktopLocalInstallCommands(manifest: unknown): string
