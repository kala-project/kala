import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '../i18n/index.js'
import { AppShellNav, DesktopSessionRail, ProductSwitcher, SidebarBrand, SidebarGlobalActions } from './AppShellNav.js'

function renderNav(overrides: Partial<Parameters<typeof AppShellNav>[0]> = {}): void {
  render(
    <AppShellNav
      section="agent"
      onSelect={() => {}}
      onOpenSettings={() => {}}
      collapsed={false}
      onCollapse={() => {}}
      onExpand={() => {}}
      {...overrides}
    />,
  )
}

describe('sidebar shell controls', () => {
  it('switches products from an expanded dropdown and marks the current route', () => {
    const onSelect = vi.fn()
    render(<ProductSwitcher section="operations" onSelect={onSelect} />)
    expect(screen.getByTestId('product-switcher-operations').getAttribute('aria-current')).toBe('page')
    fireEvent.click(screen.getByTestId('product-switcher-docs'))
    expect(onSelect).toHaveBeenCalledWith('docs')
  })

  it('exposes adaptive hooks and portals its menu outside the overflow owner', async () => {
    const { container } = render(<div className="ak-explorer-surface"><ProductSwitcher section="agent" onSelect={() => {}} adaptive /></div>)
    expect(container.querySelector('.ak-product-switcher-adaptive')).toBeTruthy()
    expect(container.querySelector('.ak-product-switcher-label')).toBeTruthy()
    expect(container.querySelector('.ak-product-switcher-chevron')).toBeTruthy()
    fireEvent.click(screen.getByTestId('product-switcher-trigger'))
    await waitFor(() => expect(screen.getByTestId('product-switcher-menu').parentElement).toBe(document.body))
    expect(container.contains(screen.getByTestId('product-switcher-menu'))).toBe(false)
  })

  it('uses the complete Kala SVG wordmark in the sidebar brand', () => {
    const { container } = render(<SidebarBrand />)
    expect(screen.getByLabelText('Kala')).toBeTruthy()
    const brand = container.querySelector('.ak-sidebar-brand')
    const wordmark = container.querySelector('.ak-sidebar-wordmark')
    expect(brand).toBeTruthy()
    expect(brand?.className).toContain('flex-1')
    expect(brand?.className).toContain('gap-3')
    expect(wordmark).toBeTruthy()
    expect(wordmark?.className).toContain('h-5')
    expect(container.querySelector('img[src$="/brand/kala-wordmark.svg"]')).toBeTruthy()
    expect(container.querySelector('img[src$="/brand/kala-wordmark-light.svg"]')).toBeTruthy()
  })

  it('keeps settings in the vertical global action owner', () => {
    const onOpenSettings = vi.fn()
    render(<SidebarGlobalActions orientation="vertical" onOpenSettings={onOpenSettings} />)
    expect(screen.getByTestId('sidebar-global-actions').getAttribute('data-orientation')).toBe('vertical')
    expect(screen.getByTestId('app-shell-download-desktop').className).not.toContain('hidden')
    fireEvent.click(screen.getByTestId('app-shell-nav-settings-icon'))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('aligns the account and accessible icon actions in one compact footer row', () => {
    render(<SidebarGlobalActions accountPlacement="footer" onOpenSettings={() => {}} account={{ displayName: 'Owner', initials: 'O' }} />)
    const actions = screen.getByTestId('app-shell-global-actions')
    const download = screen.getByTestId('app-shell-download-desktop')
    const settings = screen.getByTestId('app-shell-nav-settings-icon')

    expect(actions.getAttribute('data-presentation')).toBe('expanded-footer')
    expect(actions.className).toContain('w-full')
    expect(actions.className).toContain('bg-muted/25')
    expect(download.className).not.toContain('border-border')
    expect(actions.className).not.toContain('flex-wrap')
    expect(download.textContent).toBe('')
    expect(settings.textContent).toBe('')
    expect(download.getAttribute('aria-label')).toBeTruthy()
    expect(settings.getAttribute('aria-label')).toBeTruthy()
    expect(download.className).toContain('h-11')
    expect(settings.className).toContain('h-11')
    const account = screen.getByTestId('account-menu-trigger')
    expect(account.textContent).toBe('O')
    expect(account.getAttribute('aria-label')).toContain('Owner')
    expect(screen.getByTestId('account-menu').className).toContain('flex-1')
    expect(account.className).toContain('w-full')
    expect(download.className).toContain('flex-1')
    expect(settings.className).toContain('flex-1')
    expect(account.querySelector('.lucide-user-round')).toBeNull()
    expect(account.querySelector('button')).toBeNull()
    expect(account.compareDocumentPosition(download) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(download.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('keeps the compact account menu portalled, keyboard focused and dismissible', () => {
    const { container } = render(<div className="overflow-hidden">
      <SidebarGlobalActions accountPlacement="footer" onOpenSettings={() => {}} account={{ displayName: 'Production Owner', email: 'owner@example.test', initials: 'PO' }} />
    </div>)
    expect(screen.getByTestId('account-menu').className).not.toContain('basis-full')
    expect(screen.getByTestId('account-menu-trigger').textContent).toBe('PO')
    fireEvent.click(screen.getByTestId('account-menu-trigger'))
    const menu = screen.getByRole('menu')
    expect(menu.parentElement).toBe(document.body)
    expect(container.contains(menu)).toBe(false)
    expect(menu.contains(document.activeElement)).toBe(true)
    expect(screen.getByTestId('account-identity-summary').textContent).toContain('owner@example.test')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('account-menu-trigger'))
  })

  it('puts authorized Management alongside normal navigation, never in the account footer', async () => {
    const openManagement = vi.fn()
    const { rerender } = render(<ProductSwitcher section="agent" onSelect={() => {}} onOpenManagement={openManagement} />)
    const management = screen.getByTestId('product-switcher-management')
    expect(management.getAttribute('role')).toBe('menuitem')
    expect(management.textContent).toBe('Management')
    expect(management.title).toBe('Management tools')
    fireEvent.click(management)
    expect(openManagement).toHaveBeenCalledOnce()
    await i18n.changeLanguage('zh')
    expect(management.textContent).toBe('管理中心')
    await i18n.changeLanguage('en')
    rerender(<ProductSwitcher section="agent" onSelect={() => {}} />)
    expect(screen.queryByTestId('product-switcher-management')).toBeNull()
  })

  it('keeps an authorized management icon discoverable in the collapsed navigation rail', () => {
    const onOpenManagement = vi.fn()
    render(<DesktopSessionRail section="agent" onSelectSection={() => {}} onNewSession={() => {}} onOpenManagement={onOpenManagement} globalActions={<SidebarGlobalActions orientation="vertical" onOpenSettings={() => {}} account={{ displayName: 'Owner', initials: 'O' }} />} />)
    const management = screen.getByTestId('desktop-rail-management')
    expect(management.getAttribute('aria-label')).toBe('Management')
    expect(screen.getByTestId('desktop-rail-footer').contains(management)).toBe(false)
    fireEvent.click(management)
    expect(onOpenManagement).toHaveBeenCalledOnce()
    expect(screen.getByTestId('account-menu-trigger').textContent).toBe('')
    expect(screen.getByTestId('account-menu-trigger').getAttribute('aria-label')).toContain('Owner')
  })
})

describe('AppShellNav', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders nav tabs and marks the active section', () => {
    renderNav()
    for (const id of ['agent', 'operations', 'artifacts', 'pipeline', 'docs']) {
      expect(screen.getByTestId(`app-shell-nav-${id}`)).toBeTruthy()
    }
    expect(screen.queryByTestId('app-shell-nav-settings')).toBeNull()
    const active = screen.getByTestId('app-shell-nav-agent')
    expect(active.getAttribute('aria-current')).toBe('page')
    expect(active.className).toContain('text-foreground')
    expect(active.className).not.toContain('text-primary')
    expect(screen.queryByTestId('app-shell-open-evaluation')).toBeNull()
  })

  it('opens Evaluation only when the Runtime advertises a public URL', () => {
    renderNav({ evaluationUrl: 'https://evaluation.example.test' })
    expect(screen.getByTestId('app-shell-open-evaluation').getAttribute('href')).toBe('https://evaluation.example.test')
    expect(screen.getByTestId('app-shell-open-evaluation').getAttribute('target')).toBe('_blank')
  })

  it('offers web users an in-app dialog trigger instead of a navigation link', () => {
    renderNav()
    expect(screen.getByLabelText('Kala').querySelector('img')?.getAttribute('src')).toBe('/icons/octopus-web.svg')
    const trigger = screen.getByTestId('app-shell-download-desktop')
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.className).toContain('hidden')
    expect(trigger.className).toContain('sm:inline-flex')
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('href')).toBeNull()
    expect(trigger.getAttribute('target')).toBeNull()
  })

  it('hides browser installation entry inside the installed desktop', () => {
    Object.defineProperty(window, '__KALA_DESKTOP__', { value: true, configurable: true })
    try {
      renderNav()
      expect(screen.queryByTestId('app-shell-download-desktop')).toBeNull()
      expect(screen.getByLabelText('Kala').querySelector('img')?.getAttribute('src')).toBe('/icons/octopus-desktop.svg')
    } finally {
      delete (window as Window & { __KALA_DESKTOP__?: boolean }).__KALA_DESKTOP__
    }
  })

  it('shows the authenticated account and signs out from the account menu', () => {
    const onSignOut = vi.fn()
    renderNav({
      section: 'agent',
      account: { displayName: 'RunLab Demo', email: 'runlab-demo@example.test', initials: 'RD' },
      onSignOut,
    })
    fireEvent.click(screen.getByTestId('account-menu-trigger'))
    expect(screen.getByTestId('account-identity-summary').textContent).toContain('RunLab Demo')
    expect(screen.getByTestId('account-identity-summary').textContent).toContain('runlab-demo@example.test')
    const form = screen.getByTestId('account-sign-out').closest('form')
    expect(form?.method).toContain('post')
    expect(form?.getAttribute('action')).toBe('/auth/logout')
    fireEvent.submit(form!)
    expect(onSignOut).not.toHaveBeenCalled()
    fireEvent(window, new PageTransitionEvent('pagehide'))
    expect(onSignOut).toHaveBeenCalledOnce()
  })

  it('does not unmount the native logout form before navigation commits', () => {
    const onSignOut = vi.fn()
    renderNav({ section: 'agent', account: { displayName: 'Demo', initials: 'D' }, onSignOut })
    fireEvent.click(screen.getByTestId('account-menu-trigger'))
    const form = screen.getByTestId('account-sign-out').closest('form')!
    fireEvent.submit(form)
    expect(form.isConnected).toBe(true)
    expect(screen.getByTestId('account-sign-out')).toBeTruthy()
    expect(onSignOut).not.toHaveBeenCalled()
  })

  it('opens account details from the account menu', () => {
    const onOpenAccount = vi.fn()
    renderNav({ section: 'agent', account: { displayName: 'Demo', initials: 'D' }, onOpenAccount })
    fireEvent.click(screen.getByTestId('account-menu-trigger'))
    fireEvent.click(screen.getByTestId('account-details'))
    expect(onOpenAccount).toHaveBeenCalledOnce()
  })

  it('does not render a fake account trigger without an authenticated identity', () => {
    renderNav({ section: 'agent' })
    expect(screen.queryByTestId('account-menu')).toBeNull()
  })

  it('invokes onSelect when a tab is clicked', () => {
    const onSelect = vi.fn()
    renderNav({ section: 'agent', onSelect })
    fireEvent.click(screen.getByTestId('app-shell-nav-artifacts'))
    expect(onSelect).toHaveBeenCalledWith('artifacts')
  })

  it('settings icon fires onOpenSettings', () => {
    const onOpenSettings = vi.fn()
    renderNav({ onOpenSettings })
    fireEvent.click(screen.getByTestId('app-shell-nav-settings-icon'))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('calls onCollapse and keeps a compact topbar while collapsed', () => {
    const onCollapse = vi.fn()
    const { rerender } = render(
      <AppShellNav
        section="agent"
        onSelect={() => {}}
        onOpenSettings={() => {}}
        collapsed={false}
        onCollapse={onCollapse}
        onExpand={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('app-shell-nav-collapse'))
    expect(onCollapse).toHaveBeenCalledTimes(1)

    rerender(
      <AppShellNav
        section="agent"
        onSelect={() => {}}
        onOpenSettings={() => {}}
        collapsed
        onCollapse={onCollapse}
        onExpand={() => {}}
        collapsedContent={<span data-testid="collapsed-session-header">Session A</span>}
      />,
    )
    expect(screen.getByTestId('app-shell-nav').getAttribute('data-collapsed')).toBe('true')
    expect(screen.getByTestId('app-shell-nav').className).toContain('ak-fused-topbar-shell')
    expect(screen.getByTestId('app-shell-nav').className).toContain('px-2')
    expect(screen.getByTestId('app-shell-nav').className).toContain('py-1.5')
    expect(screen.getByTestId('collapsed-session-header').textContent).toBe('Session A')
    expect(screen.queryByTestId('app-shell-nav-agent')).toBeNull()
  })

  it('keeps a minimal brand and expand control when collapsed without session content', () => {
    const onExpand = vi.fn()
    renderNav({ collapsed: true, onExpand })

    expect(screen.getByTestId('app-shell-nav').getAttribute('data-collapsed')).toBe('true')
    expect(screen.getByLabelText('Kala')).toBeTruthy()
    expect(screen.getByLabelText('Kala').querySelector('img[src$="/brand/kala-wordmark.svg"]')).toBeTruthy()
    fireEvent.click(screen.getByTestId('app-shell-nav-expand'))
    expect(onExpand).toHaveBeenCalledOnce()
  })

  it('keeps collapse as the rightmost global control', () => {
    renderNav({ connectionStatus: <span data-testid="connection-status">Connected</span> })
    const settings = screen.getByTestId('app-shell-nav-settings-icon')
    const status = screen.getByTestId('connection-status')
    const collapse = screen.getByTestId('app-shell-nav-collapse')
    expect(settings.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(status.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('uses a compact global navigation bar and controls', () => {
    renderNav()
    expect(screen.getByTestId('app-shell-nav').className).toContain('h-10')
    expect(screen.getByTestId('app-shell-nav').className).toContain('ak-global-topbar')
    expect(screen.getByTestId('app-shell-nav').className).not.toContain('bg-background/80')
    expect(screen.getByTestId('app-shell-nav-agent').className).toContain('h-8')
    expect(screen.getByTestId('app-shell-nav-settings-icon').className).toContain('h-8')
  })

  it('does not render the inspector collapse control in the global nav', () => {
    renderNav()
    expect(screen.queryByTestId('app-shell-nav-inspector-icon')).toBeNull()
  })
})
