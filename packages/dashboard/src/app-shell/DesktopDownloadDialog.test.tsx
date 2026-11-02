import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '../i18n/index.js'
import { DesktopDownloadDialog } from './DesktopDownloadDialog.js'
import { loadDesktopApt, loadDesktopDownload } from '../lib/desktop-download.js'

vi.mock('../lib/desktop-download.js', () => ({
  desktopDownloadBase: '/downloads/desktop/',
  loadDesktopApt: vi.fn(),
  loadDesktopDownload: vi.fn(),
}))

const download = {
  release: {
    schemaVersion: 2 as const, platform: 'linux-amd64' as const, version: '0.2.0~rc.1',
    artifact: { file: 'kala-desktop_0.2.0~rc.1_amd64.deb', sha256: 'a'.repeat(64), size: 1574988 },
    dependencies: { file: 'immutable.dependencies.json', sha256: 'b'.repeat(64) },
    checksums: { file: 'immutable.SHA256SUMS.txt', sha256: 'c'.repeat(64) },
  },
  commands: "printf '%s\\n' 'named-package-hash  named.deb' | sha256sum --strict --check - &&\nsudo apt install './named.deb'",
  localCommands: 'install -m 600 downloaded.deb /tmp/verified/package.deb\nsudo apt install /tmp/verified/package.deb',
}

function open() {
  const trigger = screen.getByRole('button', { name: 'Download Linux desktop client' })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

describe('DesktopDownloadDialog', () => {
  beforeEach(() => {
    vi.mocked(loadDesktopDownload).mockResolvedValue(download)
    vi.mocked(loadDesktopApt).mockResolvedValue(null)
  })
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await i18n.changeLanguage('en') })

  it('opens without navigation, keeps the current session/draft and restores focus on Escape', async () => {
    window.history.replaceState({}, '', '/?sessionId=existing-session')
    render(<><textarea aria-label="Unsent draft" defaultValue="Keep my draft" /><DesktopDownloadDialog /></>)
    const draft = screen.getByRole('textbox')
    const trigger = open()
    expect(screen.getByRole('dialog').textContent).toContain('Linux desktop')
    await screen.findByRole('link', { name: 'Download Linux amd64 .deb' })
    expect(window.location.search).toBe('?sessionId=existing-session')
    expect(screen.getAllByRole('link').every((link) => !link.hasAttribute('target'))).toBe(true)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
    expect(screen.getByRole('textbox')).toBe(draft)
    expect((draft as HTMLTextAreaElement).value).toBe('Keep my draft')
  })

  it('shows real release details and absolute download paths with security warnings visible', async () => {
    render(<DesktopDownloadDialog />)
    open()
    const deb = await screen.findByRole('link', { name: 'Download Linux amd64 .deb' })
    expect(deb.getAttribute('href')).toBe(`/downloads/desktop/${download.release.artifact.file}`)
    expect(deb.hasAttribute('download')).toBe(true)
    expect(screen.getByRole('link', { name: 'Dependency manifest' }).getAttribute('href')).toBe('/downloads/desktop/immutable.dependencies.json')
    expect(screen.getByText(/Version 0.2.0~rc.1/)).toBeTruthy()
    expect(screen.getByRole('note').textContent).toContain('Preview build')
    expect(screen.getByRole('note').textContent).toContain('known advisories')
    expect(screen.getByText(/Checksums detect corruption/).textContent).toContain('does not enable automatic updates')
    expect(await screen.findByText(/Unavailable — a production signed APT/)).toBeTruthy()
    expect(screen.queryByText('One-paste APT install')).toBeNull()
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(screen.queryByTestId('desktop-update-restart')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close desktop downloads' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows a focused unavailable state without unrelated release warnings or artifact controls', async () => {
    let reject: (reason: Error) => void = () => {}
    vi.mocked(loadDesktopDownload).mockReturnValue(new Promise((_resolve, rejectPromise) => { reject = rejectPromise }))
    render(<DesktopDownloadDialog />)
    open()
    expect(screen.getByText(/Checking this deployment/)).toBeTruthy()
    reject(new Error('Desktop release files are incomplete. Downloads are disabled.'))
    await screen.findByText('No Linux desktop package is included in this deployment.')
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(screen.queryByTestId('desktop-release-security')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Download Linux amd64 .deb' })).toBeNull()
  })

  it('copies the full approved APT block and exposes clipboard failures without losing commands', async () => {
    const commands = "bash <<'KALA_DESKTOP_INSTALL'\nset -euo pipefail\n# Full approved fixture\nKALA_DESKTOP_INSTALL"
    vi.mocked(loadDesktopApt).mockResolvedValue(commands)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<DesktopDownloadDialog />)
    open()
    const section = await screen.findByRole('region', { name: 'One-paste APT install' })
    const copy = screen.getByTestId('copy-desktop-apt-command')
    fireEvent.click(copy)
    await waitFor(() => expect(copy.textContent).toBe('Copied'))
    expect(writeText).toHaveBeenCalledWith(commands)
    writeText.mockRejectedValueOnce(new Error('Denied'))
    fireEvent.click(copy)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(section.querySelector('pre')?.textContent).toBe(commands)
  })

  it('offers a single immediately accessible copy button for the entire download and install block', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<DesktopDownloadDialog />)
    open()
    const copy = await screen.findByTestId('copy-desktop-command')
    expect(copy.closest('details')).toBeNull()
    fireEvent.click(copy)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(download.commands))
    const region = screen.getByRole('region', { name: 'Download & install .deb' })
    expect(region.querySelector('pre')?.textContent).toBe(download.commands)
    expect(region.querySelector('[data-radix-scroll-area-viewport]')?.getAttribute('tabindex')).toBe('0')
    expect(screen.queryByText(/Your browser cannot install packages/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About Download & install .deb' }))
    expect(screen.getByRole('tooltip').textContent).toContain('Your browser cannot install packages')
  })

  it('localizes the modal, warnings, help and copy feedback into Chinese', async () => {
    await i18n.changeLanguage('zh')
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<DesktopDownloadDialog />)
    fireEvent.click(screen.getByRole('button', { name: '下载 Linux 桌面客户端' }))
    expect(screen.getByRole('dialog').textContent).toContain('Linux 桌面版')
    expect(await screen.findByRole('link', { name: '下载 Linux amd64 .deb' })).toBeTruthy()
    expect(screen.getByRole('note').textContent).toContain('预览版本')
    expect(screen.getByText(/尚未配置生产环境签名 APT/)).toBeTruthy()
    expect(screen.queryByText(/浏览器不能安装软件包/)).toBeNull()
    const copy = screen.getByRole('button', { name: '复制下载并安装 .deb' })
    fireEvent.click(copy)
    await waitFor(() => expect(copy.textContent).toBe(i18n.t('common.copied')))
    writeText.mockRejectedValueOnce(new Error('Denied'))
    fireEvent.click(copy)
    expect((await screen.findByRole('alert')).textContent).toContain('无法复制')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.aboutLabel', { label: '下载并安装 .deb' }) }))
    expect(screen.getByRole('tooltip').textContent).toContain('浏览器不能安装软件包')
    expect(screen.getByRole('button', { name: '关闭桌面客户端下载' })).toBeTruthy()
    expect(i18n.t('common.desktopConnectionHelp')).toContain('Ctrl+Shift+O')
    expect(i18n.t('common.desktopConnectionHelp')).not.toContain('Connection →')
  })

  it('offers the verified local-file install path without changing home permissions', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<DesktopDownloadDialog />)
    open()
    const details = await screen.findByTestId('desktop-local-install')
    fireEvent.click(details.querySelector('summary')!)
    fireEvent.click(screen.getByTestId('copy-desktop-local-command'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(download.localCommands))
    expect(screen.getByTestId('desktop-local-install-help').textContent).toContain('_apt')
    expect(details.querySelector('pre')?.textContent).toBe(download.localCommands)
  })

  it('adds localized unavailable context to shared loader errors', async () => {
    await i18n.changeLanguage('zh')
    vi.mocked(loadDesktopDownload).mockRejectedValue(new Error('Desktop release files are incomplete.'))
    render(<DesktopDownloadDialog />)
    fireEvent.click(screen.getByTestId('app-shell-download-desktop'))
    expect((await screen.findByRole('status')).textContent).toContain('当前部署未包含 Linux 桌面安装包。')
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })
  it('shows the localized restart requirement only for an update dialog', async () => {
    await i18n.changeLanguage('zh')
    render(<DesktopDownloadDialog update />)
    fireEvent.click(screen.getByTestId('app-shell-download-desktop'))
    const notice = await screen.findByTestId('desktop-update-restart')
    expect(notice.textContent).toContain('从托盘菜单选择“退出”')
    expect(notice.textContent).toContain('不会替换正在运行的进程')
  })

  it('does not expose a command for malformed APT configuration', async () => {
    vi.mocked(loadDesktopApt).mockRejectedValue(new Error('APT installation requires an approved HTTPS URL and full primary key fingerprint.'))
    render(<DesktopDownloadDialog />)
    open()
    expect((await screen.findByRole('alert')).textContent).toContain('approved HTTPS URL')
    expect(screen.queryByText('One-paste APT install')).toBeNull()
  })
})
