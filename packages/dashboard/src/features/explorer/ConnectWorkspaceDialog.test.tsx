import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConnectWorkspaceDialog } from './ConnectWorkspaceDialog.js'

const base = {
  id: 'inst_1', platform: 'linux', mode: 'service', privilegeMode: 'privileged', workspaceRoot: '__KALA_CURRENT_DIRECTORY__',
  status: 'created', seq: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:15:00Z',
  command: "curl -fsSL 'http://localhost:3000/install' | KALA_SETUP_CODE='A1B2C3D4E5' KALA_INSTALL_MODE='service' sh", setupCode: 'A1B2C3D4E5',
}

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body, text: async () => JSON.stringify(body) } as Response
}

describe('ConnectWorkspaceDialog', () => {
  let windowsCapability: 'ready' | 'unavailable' | 'error' | 'invalid'
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    windowsCapability = 'unavailable'
    vi.useFakeTimers({ shouldAdvanceTime: true })
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = String(input)
      const url = rawUrl.replace(/^http:\/\/host\.test:5301/u, '').replace(/^https:\/\/cloud\.example\.test/u, '')
      if (url === '/api/executor-install-capabilities') {
        if (windowsCapability === 'error') return response({ error: 'unavailable' }, false)
        if (windowsCapability === 'invalid') return response({ platforms: { windows: { available: 'true' } } })
        return response({ platforms: { linux: { available: true }, macos: { available: true }, windows: { available: windowsCapability === 'ready' } } })
      }
      if ((url === '/auth/executor-invites' || url === 'https://cloud.example.test/auth/executor-invites') && init?.method === 'POST') return response({ id: 'inv_1', inviteToken: 'ak_invite_org_a' })
      if (url === '/api/executor-installs' && init?.method === 'POST') {
        const input = JSON.parse(String(init.body)) as Record<string, string>
        if (input.platform === 'windows') return response({ ...base, ...input, command: "$env:KALA_SETUP_CODE='F6E7D8C9B0'; irm 'http://localhost:3000/install.ps1' | iex" })
        if (input.platform === 'macos' || input.mode === 'temporary') {
          return response({
            ...base,
            id: 'inst_2',
            ...input,
            command: "curl -fsSL 'http://localhost:3000/install' | KALA_SETUP_CODE='F6E7D8C9B0' KALA_INSTALL_MODE='temporary' sh",
            setupCode: 'F6E7D8C9B0',
          })
        }
        return response({ ...base, ...input })
      }
      if (url.endsWith('/events?after=0')) return response({ events: [] })
      if (url === '/api/executor-installs/inst_1' && init?.method === 'DELETE') return response({ ok: true })
      if (url.endsWith('/approve')) return response({ ...base, status: 'paired', seq: 4 })
      if (url.endsWith('/reject')) return response({ ...base, status: 'rejected', seq: 4 })
      if (url === '/api/executor-installs/inst_1') return response(base)
      throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`)
    }))
  })

  it('defaults to Linux Service and Privileged modes while keeping expert options hidden', async () => {
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)
    expect(screen.getByTestId('connect-workspace-expert-mode').getAttribute('aria-checked')).toBe('false')
    expect(screen.queryByTestId('connect-workspace-service')).toBeNull()
    expect(screen.queryByTestId('connect-workspace-privileged')).toBeNull()
    const createCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({ mode: 'service', privilegeMode: 'privileged' })
    expect(screen.getByTestId('connect-workspace-linux').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByLabelText(/workspace root/i)).toBeNull()
    expect(screen.queryByText(/no sudo required/i)).toBeNull()
    expect(screen.getByRole('region', { name: 'Installation options' })).toBeTruthy()
    expect(screen.getByTestId('connect-workspace-linux').className).toContain('bg-accent')
    expect(screen.getByTestId('connect-workspace-linux').querySelector('img')?.getAttribute('src')).toBe('/icons/linux.svg')
    expect(screen.getByTestId('connect-workspace-macos').querySelector('img')?.getAttribute('src')).toBe('/icons/macos.svg')
    expect(screen.getByTestId('connect-workspace-windows').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('connect-workspace-windows-notice').textContent).toContain('not available on this deployment')
    expect(screen.getByTestId('installation-status').querySelector('svg')).toBeTruthy()
    const dialog = screen.getByTestId('connect-workspace-dialog')
    expect(dialog.className).toContain('rounded-t-2xl')
    expect(dialog.className).toContain('sm:rounded-3xl')
    expect(screen.getByText('Workspace setup')).toBeTruthy()
    const terminal = screen.getByTestId('executor-terminal-command')
    expect(terminal.className).toContain('rounded-2xl')
    expect(terminal.className).toContain('bg-muted/35')
    expect(terminal.className).toContain('text-foreground')
    expect(terminal.className).not.toContain('bg-foreground')
    expect(screen.getByTestId('copy-executor-command').className).toContain('w-full')
    expect(terminal.className).not.toContain('ring-1')
    const command = terminal.textContent ?? ''
    expect(command).toContain('/install')
    expect(command).toContain('A1B2C3D4E5')
    expect(command).not.toContain('\n')
    expect(command).not.toMatch(/sudo|systemctl|launchctl|sc\.exe|kala-executor|ak_install_/i)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('executor-invites'))).toBe(false)
  })

  it('supports Linux and macOS, both modes, immediate updates, and copies exactly one line', async () => {
    const write = vi.mocked(navigator.clipboard.writeText)
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)
    fireEvent.click(screen.getByTestId('connect-workspace-expert-mode'))
    fireEvent.click(screen.getByTestId('connect-workspace-macos'))
    fireEvent.click(screen.getByTestId('connect-workspace-temporary'))
    await waitFor(() => expect(screen.getByText(/F6E7D8C9B0/)).toBeTruthy())
    expect(screen.getByTestId('executor-terminal-command').textContent).toContain("KALA_INSTALL_MODE='temporary'")
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === '/api/executor-installs' && init?.method === 'POST' && String(init.body).includes('temporary'))).toBe(true)
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === '/api/executor-installs/inst_1' && init?.method === 'DELETE')).toBe(true)
    fireEvent.click(screen.getByTestId('copy-executor-command'))
    await waitFor(() => expect(write).toHaveBeenCalledOnce())
    expect(write.mock.calls[0]![0]).not.toMatch(/[\r\n]/u)
    expect(screen.getByTestId('connect-workspace-macos')).toBeTruthy()
  })

  it('fails closed without silently installing Linux on a Windows browser', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === '/api/executor-install-capabilities')).toBe(true))
    expect(screen.getByTestId('connect-workspace-windows').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('connect-workspace-windows').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('connect-workspace-windows-notice').textContent).toContain('not available on this deployment')
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    expect(screen.getByTestId('copy-executor-command').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByTestId('connect-workspace-linux'))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === '/api/executor-installs' && init?.method === 'POST')).toBe(true))
  })

  it('creates a Windows install only after explicit Host asset readiness', async () => {
    windowsCapability = 'ready'
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/install\.ps1/)
    expect(screen.getByTestId('connect-workspace-windows').hasAttribute('disabled')).toBe(false)
    const creates = vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === '/api/executor-installs' && init?.method === 'POST')
    expect(creates).toHaveLength(1)
    expect(JSON.parse(String(creates[0]?.[1]?.body))).toMatchObject({ platform: 'windows', mode: 'service' })
  })

  it.each(['error', 'invalid'] as const)('keeps Windows disabled when capability is %s', async (kind) => {
    windowsCapability = kind
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === '/api/executor-install-capabilities')).toBe(true))
    expect(screen.getByTestId('connect-workspace-windows').hasAttribute('disabled')).toBe(true)
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('immediately shows the target run mode, keeps the previous command visible, and prevents copying while refreshing', async () => {
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)

    fireEvent.click(screen.getByTestId('connect-workspace-expert-mode'))
    fireEvent.click(screen.getByTestId('connect-workspace-temporary'))

    const terminal = screen.getByTestId('executor-terminal-command')
    expect(terminal.getAttribute('data-mode')).toBe('temporary')
    expect(terminal.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByTestId('executor-command-transition')).toBeTruthy()
    expect(screen.getByTestId('copy-executor-command').hasAttribute('disabled')).toBe(true)
    expect(terminal.textContent).toContain('A1B2C3D4E5')

    await waitFor(() => expect(screen.getByText(/F6E7D8C9B0/)).toBeTruthy())
    expect(terminal.getAttribute('aria-busy')).toBe('false')
    expect(screen.queryByTestId('executor-command-transition')).toBeNull()
    expect(screen.getByTestId('copy-executor-command').hasAttribute('disabled')).toBe(false)
  })

  it('shows permission choices only in Expert Service mode and resets defaults when Expert mode closes', async () => {
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)
    fireEvent.click(screen.getByTestId('connect-workspace-expert-mode'))
    expect(screen.getByTestId('connect-workspace-service').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('connect-workspace-privileged').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('connect-workspace-service').textContent).toContain('Recommended')
    expect(screen.getByTestId('connect-workspace-privileged').textContent).toContain('Recommended')

    fireEvent.click(screen.getByTestId('connect-workspace-restricted'))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST' && String(init.body).includes('"privilegeMode":"restricted"'))).toBe(true))
    fireEvent.click(screen.getByTestId('connect-workspace-temporary'))
    expect(screen.queryByTestId('connect-workspace-privileged')).toBeNull()

    fireEvent.click(screen.getByTestId('connect-workspace-expert-mode'))
    expect(screen.queryByTestId('connect-workspace-expert-options')).toBeNull()
    await waitFor(() => {
      const latestCreate = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST').at(-1)
      expect(JSON.parse(String(latestCreate?.[1]?.body))).toMatchObject({ mode: 'service', privilegeMode: 'privileged' })
    })
  })

  it('uses the active host endpoint for install APIs when provided', async () => {
    render(<ConnectWorkspaceDialog open host="http://host.test:5301" onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === 'http://host.test:5301/api/executor-installs' && init?.method === 'POST')).toBe(true)
  })

  it('uses an organization-bound invite instead of the anonymous pairing flow in Private Cloud', async () => {
    render(<ConnectWorkspaceDialog open privateCloud organizationRole="admin" host="https://cloud.example.test" onOpenChange={() => {}} />)
    const command = await screen.findByText(/EXECUTOR_INVITE=/)
    expect(command.textContent).toContain("curl -fsSL 'https://cloud.example.test/install/invite.sh'")
    expect(command.textContent).toContain("EXECUTOR_INVITE='ak_invite_org_a'")
    expect(command.textContent).not.toContain('KALA_RELEASE_BASE_URL')
    expect(command.textContent).not.toContain('KALA_SETUP_CODE')
    expect(screen.getByTestId('connect-workspace-expert-mode').getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByTestId('connect-workspace-expert-mode'))
    expect(screen.getByTestId('connect-workspace-service').getAttribute('aria-pressed')).toBe('true')
    expect(command.textContent).not.toContain('KALA_INVITE_INSTALL_MODE')
    expect(command.textContent).toContain('bash)')
    fireEvent.click(screen.getByTestId('connect-workspace-restricted'))
    await waitFor(() => expect(command.textContent).toContain("KALA_INVITE_PRIVILEGE_MODE='restricted'"))
    fireEvent.click(screen.getByTestId('connect-workspace-temporary'))
    await waitFor(() => expect(command.textContent).toContain("KALA_INVITE_INSTALL_MODE='temporary'"))
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === 'https://cloud.example.test/auth/executor-invites' && init?.method === 'POST')).toBe(true)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/executor-installs'))).toBe(false)
  })

  it('issues a Windows PowerShell invite command only with Private Cloud asset readiness', async () => {
    windowsCapability = 'ready'
    render(<ConnectWorkspaceDialog open privateCloud organizationRole="admin" host="https://cloud.example.test" onOpenChange={() => {}} />)
    await screen.findByText(/EXECUTOR_INVITE=/)
    fireEvent.click(screen.getByTestId('connect-workspace-windows'))
    await waitFor(() => expect(screen.getByTestId('executor-terminal-command').textContent).toContain('/install/invite.ps1'))
    const command = screen.getByTestId('executor-terminal-command').textContent ?? ''
    expect(command).toContain("$env:EXECUTOR_INVITE='ak_invite_org_a'")
    expect(command).not.toContain('KALA_RELEASE_TRUST')
    expect(command).toContain("$env:KALA_INVITE_INSTALL_MODE='service'")
    expect(command).not.toContain('curl -fsSL')
    fireEvent.click(screen.getByTestId('connect-workspace-expert-mode'))
    expect(screen.getByTestId('connect-workspace-restricted').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByTestId('connect-workspace-temporary'))
    await waitFor(() => expect(screen.getByTestId('executor-terminal-command').textContent).toContain("KALA_INVITE_INSTALL_MODE='temporary'"))
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/auth/executor-invites'))).toHaveLength(1)
  })

  it('clearly blocks non-admin members without creating an invite', async () => {
    render(<ConnectWorkspaceDialog open privateCloud organizationRole="member" onOpenChange={() => {}} />)
    expect((await screen.findByTestId('executor-invite-admin-required')).textContent).toMatch(/owner or administrator/i)
    expect(screen.queryByTestId('executor-terminal-command')).toBeNull()
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('closes when the backdrop is clicked', async () => {
    const onOpenChange = vi.fn()
    render(<ConnectWorkspaceDialog open onOpenChange={onOpenChange} />)
    await screen.findByText(/curl -fsSL/)
    fireEvent.pointerDown(screen.getByTestId('dialog-overlay'))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('stops polling without invalidating the copied setup command when closed', async () => {
    const view = render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText(/curl -fsSL/)
    view.rerender(<ConnectWorkspaceDialog open={false} onOpenChange={() => {}} />)
    const count = vi.mocked(fetch).mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(vi.mocked(fetch).mock.calls).toHaveLength(count)
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === '/api/executor-installs/inst_1' && init?.method === 'DELETE')).toBe(false)
  })

  it('shows pairing approval and handles clipboard failure', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/executor-installs' && init?.method === 'POST') return response({ ...base, status: 'pairing_pending', seq: 3, metadata: { pairingCode: '123456' } })
      if (url.endsWith('/approve')) return response({ ...base, status: 'paired', seq: 4 })
      if (url.endsWith('/events?after=3')) return response({ events: [] })
      if (url === '/api/executor-installs/inst_1') return response({ ...base, status: 'pairing_pending', seq: 3 })
      if (init?.method === 'DELETE') return response({ ok: true })
      throw new Error(`unexpected ${url}`)
    })
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('clipboard denied'))
    render(<ConnectWorkspaceDialog open onOpenChange={() => {}} />)
    await screen.findByText('123456')
    fireEvent.click(screen.getByTestId('copy-executor-command'))
    await screen.findByText(/clipboard denied/)
    fireEvent.click(screen.getByRole('button', { name: /approve/i }))
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/approve'))).toBe(true))
  })
})
