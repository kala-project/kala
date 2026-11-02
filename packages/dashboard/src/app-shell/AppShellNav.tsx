import { useTranslation } from 'react-i18next'
import { Activity, BookOpen, Bot, Boxes, ChevronDown, ChevronUp, CircleHelp, Download, ExternalLink, FolderOpen, LogOut, NotebookPen, PanelLeftClose, PanelLeftOpen, Plus, Settings as SettingsIcon, Sparkles, UserRound, Workflow } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Button } from '../components/ui/button.js'
import { ScrollArea } from '../components/ui/scroll-area.js'
import { cn } from '../lib/utils.js'
import type { AccountProfile } from '../auth-session.js'
import type { AppSection } from './section.js'
import { isDesktopClient } from '../lib/desktop.js'
import { staticAssetUrl } from '../lib/static-asset-url.js'
import { DesktopDownloadDialog } from './DesktopDownloadDialog.js'
import { DesktopUpdateEntry } from './DesktopUpdate.js'

type NavItem = {
  id: AppSection
  labelKey: string
  Icon: typeof Bot
  testid: string
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: 'agent', labelKey: 'appShell.nav.agent', Icon: Bot, testid: 'app-shell-nav-agent' },
  { id: 'operations', labelKey: 'appShell.nav.operations', Icon: Workflow, testid: 'app-shell-nav-operations' },
  { id: 'artifacts', labelKey: 'appShell.nav.artifacts', Icon: Boxes, testid: 'app-shell-nav-artifacts' },
  { id: 'pipeline', labelKey: 'appShell.nav.pipeline', Icon: Sparkles, testid: 'app-shell-nav-pipeline' },
  { id: 'docs', labelKey: 'appShell.nav.docs', Icon: BookOpen, testid: 'app-shell-nav-docs' },
  { id: 'memo', labelKey: 'appShell.nav.memo', Icon: NotebookPen, testid: 'app-shell-nav-memo' },
]

export function ProductSwitcher({
  section,
  onSelect,
  compact = false,
  adaptive = false,
  onOpenManagement,
}: {
  section: AppSection
  onSelect(section: AppSection): void
  compact?: boolean
  adaptive?: boolean
  onOpenManagement?(): void
}): JSX.Element {
  const { t } = useTranslation()
  const detailsRef = useRef<HTMLDetailsElement | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const [adaptiveOpen, setAdaptiveOpen] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number } | null>(null)
  const activeItem = NAV_ITEMS.find((item) => item.id === section) ?? NAV_ITEMS[0]!
  const ActiveIcon = activeItem.Icon
  const select = (next: AppSection): void => {
    if (detailsRef.current) detailsRef.current.open = false
    setAdaptiveOpen(false)
    onSelect(next)
  }
  const positionAdaptiveMenu = useCallback(() => {
    const trigger = triggerRef.current
    if (!adaptive || !trigger) return
    const triggerRect = trigger.getBoundingClientRect()
    const surfaceRect = trigger.closest('.ak-explorer-surface')?.getBoundingClientRect()
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const availableWidth = Math.max(160, (surfaceRect?.right ?? window.innerWidth) - triggerRect.left - rootFontSize)
    setMenuPosition({ left: triggerRect.left, top: triggerRect.bottom + rootFontSize * 0.5, width: Math.min(rootFontSize * 16, availableWidth) })
  }, [adaptive])
  useLayoutEffect(() => {
    if (!adaptiveOpen) return
    positionAdaptiveMenu()
    window.addEventListener('resize', positionAdaptiveMenu)
    window.addEventListener('scroll', positionAdaptiveMenu, true)
    return () => {
      window.removeEventListener('resize', positionAdaptiveMenu)
      window.removeEventListener('scroll', positionAdaptiveMenu, true)
    }
  }, [adaptiveOpen, positionAdaptiveMenu])
  const menu = (
    <div
      role="menu"
      className={cn('ak-product-switcher-menu z-50 overflow-hidden rounded-2xl border border-border/55 bg-popover p-1.5 text-popover-foreground shadow-xl', adaptive ? 'fixed' : 'absolute', compact ? 'left-full top-0 ml-2' : adaptive ? '' : 'left-0 top-full mt-2')}
      style={adaptive && menuPosition ? menuPosition : undefined}
      data-testid="product-switcher-menu"
    >
      <div className="px-2.5 pb-1.5 pt-1 text-caption font-medium uppercase tracking-[0.12em] text-muted-foreground">Kala</div>
      {NAV_ITEMS.map(({ id, labelKey, Icon }) => (
        <button key={id} type="button" role="menuitem" aria-current={section === id ? 'page' : undefined} data-testid={`product-switcher-${id}`} onClick={() => select(id)} className={cn('flex min-h-10 w-full items-center gap-3 rounded-xl px-2.5 text-left text-sm hover:bg-accent', section === id && 'bg-accent/70 font-medium')}>
          <Icon className="h-4 w-4 flex-none text-muted-foreground" aria-hidden />
          <span>{t(labelKey)}</span>
        </button>
      ))}
      {onOpenManagement ? (
        <button type="button" role="menuitem" data-testid="product-switcher-management" title={t('deploymentCenter.title')} onClick={() => { if (detailsRef.current) detailsRef.current.open = false; setAdaptiveOpen(false); onOpenManagement() }} className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 text-left text-sm hover:bg-accent">
          <Activity className="h-4 w-4 flex-none text-muted-foreground" aria-hidden />
          <span>{t('deploymentCenter.nav')}</span>
        </button>
      ) : null}
    </div>
  )
  return (
    <>
      <details ref={detailsRef} onToggle={(event) => { if (adaptive) setAdaptiveOpen(event.currentTarget.open) }} className={cn('relative', compact ? '' : adaptive ? 'ak-product-switcher-adaptive z-50 flex-none' : 'w-full')} data-testid="product-switcher">
        <summary
          ref={triggerRef}
          className={cn(
            'flex cursor-pointer list-none items-center text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden',
            compact ? 'h-10 w-10 justify-center rounded-xl hover:bg-accent' : adaptive ? 'h-9 gap-1.5 rounded-xl px-0.5 text-muted-foreground hover:bg-muted hover:text-foreground' : 'h-11 w-full gap-3 rounded-xl border border-border/45 bg-background/45 px-3 shadow-sm hover:bg-accent',
          )}
          title={compact ? t(activeItem.labelKey) : t('appShell.nav.aria')}
          aria-label={t('appShell.nav.aria')}
          data-testid="product-switcher-trigger"
        >
          <span className={cn('grid h-8 w-8 flex-none place-items-center rounded-lg', adaptive ? 'bg-transparent text-current' : 'bg-primary/10 text-primary')}><ActiveIcon className="h-4 w-4" aria-hidden /></span>
          {!compact ? <><span className="ak-product-switcher-label min-w-0 flex-1 truncate text-left text-sm font-medium">{t(activeItem.labelKey)}</span><ChevronDown className="ak-product-switcher-chevron h-4 w-4 text-muted-foreground" aria-hidden /></> : null}
        </summary>
        {!adaptive ? menu : null}
      </details>
      {adaptiveOpen && menuPosition ? createPortal(menu, document.body) : null}
    </>
  )
}

export function SidebarBrand({ connectionStatus }: { connectionStatus?: ReactNode }): JSX.Element {
  return (
    <span aria-label="Kala" className="ak-sidebar-brand flex min-w-0 flex-1 items-center gap-3 text-foreground">
      {connectionStatus ?? <img src={staticAssetUrl(isDesktopClient() ? '/icons/octopus-desktop.svg' : '/icons/octopus-web.svg')} alt="" className="h-6 w-6 flex-none" aria-hidden />}
      <KalaWordmark className="h-5" />
    </span>
  )
}

function KalaWordmark({ className }: { className?: string }): JSX.Element {
  return (
    <span className={cn('ak-sidebar-wordmark relative block flex-none', className)} aria-hidden="true">
      <img src={staticAssetUrl('/brand/kala-wordmark.svg')} alt="" className="h-full w-auto dark:hidden" />
      <img src={staticAssetUrl('/brand/kala-wordmark-light.svg')} alt="" className="hidden h-full w-auto dark:block" />
    </span>
  )
}

export function DesktopSessionRail({
  section,
  onSelectSection,
  connectionStatus,
  onExpand,
  onNewSession,
  onConnectWorkspace,
  globalActions,
  onOpenManagement,
}: {
  section: AppSection
  onSelectSection(section: AppSection): void
  connectionStatus?: ReactNode
  onExpand?: () => void
  onNewSession(): void
  onConnectWorkspace?: () => void
  globalActions: ReactNode
  onOpenManagement?(): void
}): JSX.Element {
  const { t } = useTranslation()
  const actionClass = 'h-10 w-10 rounded-xl border border-transparent text-muted-foreground hover:border-border/35 hover:bg-muted hover:text-foreground'
  return (
    <aside
      className={cn('flex h-full w-16 flex-none flex-col items-center border-r border-border/45 bg-card/90 py-3 text-foreground shadow-[1px_0_0_hsl(var(--border)/0.12)]', onExpand && 'cursor-pointer')}
      data-testid="desktop-session-rail"
      aria-label={t('appShell.nav.aria')}
      onClick={(event) => {
        if (!onExpand) return
        const target = event.target
        if (target instanceof Element && target.closest('button, a, summary, input, select, textarea, [role="menuitem"]')) return
        onExpand()
      }}
    >
      <div className="mb-2 grid h-10 w-10 place-items-center" data-testid="desktop-rail-brand">
        {connectionStatus ?? <img src={staticAssetUrl(isDesktopClient() ? '/icons/octopus-desktop.svg' : '/icons/octopus-web.svg')} alt="" className="h-6 w-6" aria-hidden />}
      </div>
      <ProductSwitcher section={section} onSelect={onSelectSection} compact onOpenManagement={onOpenManagement} />
      {onOpenManagement ? <Button type="button" variant="ghost" size="icon" className={actionClass} title={t('deploymentCenter.title')} aria-label={t('deploymentCenter.nav')} onClick={onOpenManagement} data-testid="desktop-rail-management"><Activity className="h-4 w-4" aria-hidden /></Button> : null}
      {section === 'agent' ? (
        <div className="mt-3 flex flex-col items-center gap-1.5" data-testid="desktop-rail-agent-actions">
          {onExpand ? <Button type="button" variant="ghost" size="icon" className={actionClass} title={t('app.openExplorer')} aria-label={t('app.openExplorer')} data-testid="desktop-rail-expand" onClick={onExpand}><PanelLeftOpen className="h-4 w-4" aria-hidden /></Button> : null}
          <Button type="button" variant="ghost" size="icon" className={actionClass} title={t('app.newSessionButton')} aria-label={t('app.newSessionButton')} data-testid="desktop-rail-new-session" onClick={onNewSession}><Plus className="h-4 w-4" aria-hidden /></Button>
          {onConnectWorkspace ? <Button type="button" variant="ghost" size="icon" className={actionClass} title={t('app.cockpit.connectWorkspace')} aria-label={t('app.cockpit.connectWorkspace')} data-testid="desktop-rail-connect-workspace" onClick={onConnectWorkspace}><FolderOpen className="h-4 w-4" aria-hidden /></Button> : null}
        </div>
      ) : null}
      <div className="mt-auto" data-testid="desktop-rail-footer">{globalActions}</div>
    </aside>
  )
}

type ActivePill = {
  left: number
  top: number
  width: number
  height: number
}

export function AppShellNav({
  section,
  onSelect,
  onOpenSettings,
  connectionStatus,
  collapsed,
  collapsedContent,
  onCollapse,
  onExpand,
  account,
  accountLoading = false,
  onSignOut,
  onOpenAccount,
  onOpenAdmin,
  evaluationUrl,
}: {
  section: AppSection
  onSelect(section: AppSection): void
  onOpenSettings(): void
  connectionStatus?: ReactNode
  collapsed: boolean
  collapsedContent?: ReactNode
  onCollapse(): void
  onExpand(): void
  account?: AccountProfile
  accountLoading?: boolean
  onSignOut?(): void | Promise<void>
  onOpenAccount?(): void
  onOpenAdmin?(): void
  evaluationUrl?: string
}): JSX.Element {
  const { t } = useTranslation()
  const navItemsRef = useRef<HTMLDivElement | null>(null)
  const activeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [activePill, setActivePill] = useState<ActivePill | null>(null)

  const measureActivePill = useCallback(() => {
    const container = navItemsRef.current
    const activeButton = activeButtonRef.current
    if (!container || !activeButton) {
      setActivePill(null)
      return
    }
    const containerRect = container.getBoundingClientRect()
    const activeRect = activeButton.getBoundingClientRect()
    setActivePill({
      left: activeRect.left - containerRect.left + container.scrollLeft,
      top: activeRect.top - containerRect.top,
      width: Math.max(0, activeRect.width),
      height: Math.max(0, activeRect.height),
    })
  }, [])

  useLayoutEffect(() => {
    if (collapsed) return
    measureActivePill()
    const container = navItemsRef.current
    if (!container) return
    const resizeObserver = new ResizeObserver(measureActivePill)
    resizeObserver.observe(container)
    if (activeButtonRef.current) resizeObserver.observe(activeButtonRef.current)
    container.addEventListener('scroll', measureActivePill, { passive: true })
    window.addEventListener('resize', measureActivePill)
    return () => {
      resizeObserver.disconnect()
      container.removeEventListener('scroll', measureActivePill)
      window.removeEventListener('resize', measureActivePill)
    }
  }, [collapsed, measureActivePill, section])

  if (collapsed) {
    return (
      <nav
        aria-label={t('appShell.nav.aria')}
        data-testid="app-shell-nav"
        data-collapsed="true"
        className={cn(
          'sticky top-0 z-30 flex items-center backdrop-blur-xl',
          collapsedContent ? 'ak-fused-topbar-shell h-14 gap-0 px-2 py-1.5 sm:px-3' : 'ak-global-topbar h-10 gap-2 px-2 sm:px-3',
        )}
      >
        {collapsedContent ?? (
          <span aria-label="Kala" className="group flex min-w-0 items-center gap-2.5 text-foreground">
            <img
              src={staticAssetUrl(isDesktopClient() ? '/icons/octopus-desktop.svg' : '/icons/octopus-web.svg')}
              alt=""
              className="h-5 w-5 text-foreground/90"
              aria-hidden
            />
            <KalaWordmark className="h-5" />
          </span>
        )}
        {!collapsedContent ? (
          <>
            <span className="min-w-0 flex-1" />
            <Button
              variant="ghost"
              size="icon"
              data-testid="app-shell-nav-expand"
              onClick={onExpand}
              title={t('app.expandTopbar')}
              aria-label={t('app.expandTopbar')}
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className="h-4 w-4" aria-hidden />
            </Button>
          </>
        ) : null}
      </nav>
    )
  }

  return (
    <nav
      aria-label={t('appShell.nav.aria')}
      data-testid="app-shell-nav"
      data-collapsed="false"
      className="ak-global-topbar sticky top-0 z-30 flex h-10 items-center gap-1 px-2 backdrop-blur-xl sm:px-3"
    >
      <span
        aria-label="Kala"
        className="group mr-5 hidden items-center gap-2.5 text-foreground sm:flex"
      >
        <img
          src={staticAssetUrl(isDesktopClient() ? '/icons/octopus-desktop.svg' : '/icons/octopus-web.svg')}
          alt=""
          className="h-5 w-5 text-foreground/90 transition-transform duration-200 ease-out group-hover:rotate-[2deg] group-hover:scale-[1.04] motion-reduce:transition-none"
          aria-hidden
        />
        <KalaWordmark className="h-5" />
      </span>
      <ScrollArea
        viewportRef={navItemsRef}
        className="min-w-0 flex-1"
        viewportClassName="snap-x snap-mandatory"
        contentClassName="relative flex min-w-full w-max items-center gap-1">
        {activePill ? (
          <span
            className="pointer-events-none absolute z-0 rounded-xl bg-card/80 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.32)] transition-[transform,width,height,opacity] duration-200 ease-out motion-reduce:transition-none"
            style={{
              width: activePill.width,
              height: activePill.height,
              transform: `translate3d(${activePill.left}px, ${activePill.top}px, 0)`,
            }}
            aria-hidden
          />
        ) : null}
        {NAV_ITEMS.map(({ id, labelKey, Icon, testid }) => {
          const active = section === id
          return (
            <Button
              key={id}
              variant="ghost"
              size="sm"
              ref={active ? activeButtonRef : undefined}
              data-testid={testid}
              aria-current={active ? 'page' : undefined}
              title={t(labelKey)}
              onClick={() => onSelect(id)}
              className={cn(
                'relative z-10 h-8 flex-none snap-start gap-1.5 overflow-hidden px-2 text-xs transition-colors duration-150 sm:px-2.5',
                active
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )}
            >
              <Icon className="relative h-4 w-4 flex-none" aria-hidden />
              <span className="relative hidden lg:inline">{t(labelKey)}</span>
            </Button>
          )
        })}
      </ScrollArea>
      <AppShellGlobalActions connectionStatus={connectionStatus} onOpenSettings={onOpenSettings} account={account} accountLoading={accountLoading} onSignOut={onSignOut} onOpenAccount={onOpenAccount} onOpenAdmin={onOpenAdmin} evaluationUrl={evaluationUrl} collapseControl={{ kind: 'collapse', onClick: onCollapse }} />
    </nav>
  )
}

type GlobalActionProps = {
  connectionStatus?: ReactNode
  onOpenSettings(): void
  account?: AccountProfile
  accountLoading?: boolean
  onSignOut?(): void | Promise<void>
  onOpenAccount?(): void
  onOpenAdmin?(): void
  evaluationUrl?: string
  collapseControl?: { kind: 'collapse' | 'expand'; onClick(): void; sidebar?: boolean }
}

export function AppShellGlobalActions(props: GlobalActionProps): JSX.Element {
  return <SidebarGlobalActions {...props} orientation="horizontal" legacyTopbar />
}

export function SidebarGlobalActions({
  connectionStatus,
  onOpenSettings,
  account,
  accountLoading = false,
  onSignOut,
  onOpenAccount,
  onOpenAdmin,
  evaluationUrl,
  collapseControl,
  orientation = 'horizontal',
  accountPlacement,
  legacyTopbar = false,
}: GlobalActionProps & { orientation?: 'horizontal' | 'vertical'; accountPlacement?: 'default' | 'rail' | 'footer'; legacyTopbar?: boolean }): JSX.Element {
  const { t } = useTranslation()
  const vertical = orientation === 'vertical'
  const expandedFooter = accountPlacement === 'footer' && !legacyTopbar
  const actionClass = cn(
    vertical ? 'h-11 w-11 rounded-xl' : expandedFooter ? 'h-11 w-11 flex-none rounded-lg' : 'h-8 w-8',
    'text-muted-foreground hover:text-foreground',
  )
  const iconActionClass = cn(vertical ? 'h-10 w-10 rounded-xl' : 'h-8 w-8', 'text-muted-foreground hover:text-foreground')
  return (
    <div className={cn('flex flex-none gap-1', vertical ? 'flex-col items-center' : expandedFooter ? 'w-full items-center rounded-xl bg-muted/25 p-1' : 'ml-auto items-center')} data-testid={vertical ? 'sidebar-global-actions' : 'app-shell-global-actions'} data-orientation={orientation} data-presentation={expandedFooter ? 'expanded-footer' : undefined}>
      {expandedFooter && (account || accountLoading) ? <AccountMenu account={account} loading={accountLoading} onSignOut={onSignOut} onOpenAccount={onOpenAccount} onOpenAdmin={onOpenAdmin} placement="footer" /> : null}
      {!isDesktopClient() ? legacyTopbar ? <DesktopDownloadDialog /> : <DesktopDownloadDialog trigger={<Button variant="ghost" size="icon" className={actionClass} data-testid="app-shell-download-desktop" title={t('desktopDownload.title')} aria-label={t('desktopDownload.open')}><Download className="h-4 w-4 flex-none" aria-hidden /></Button>} /> : <DesktopUpdateEntry />}
      {evaluationUrl ? (
        <Button variant="ghost" size="icon" asChild className={iconActionClass}>
          <a href={evaluationUrl} target="_blank" rel="noreferrer" data-testid="app-shell-open-evaluation" title={t('appShell.nav.evaluation')} aria-label={t('appShell.nav.evaluation')}><ExternalLink className="h-4 w-4" aria-hidden /></a>
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        data-testid="app-shell-nav-settings-icon"
        onClick={onOpenSettings}
        title={t('app.openSettings')}
        aria-label={t('app.openSettings')}
        className={actionClass}
      >
        <SettingsIcon className="h-4 w-4 flex-none" aria-hidden />
      </Button>
      {!expandedFooter && (account || accountLoading) ? <AccountMenu account={account} loading={accountLoading} onSignOut={onSignOut} onOpenAccount={onOpenAccount} onOpenAdmin={onOpenAdmin} placement={accountPlacement ?? (vertical ? 'rail' : 'default')} /> : null}
      {connectionStatus}
      {collapseControl ? (
        <Button
          variant="ghost"
          size="icon"
          data-testid={collapseControl.kind === 'collapse' ? 'app-shell-nav-collapse' : 'app-shell-nav-expand'}
          onClick={collapseControl.onClick}
          title={t(collapseControl.sidebar ? 'app.hideSidebar' : collapseControl.kind === 'collapse' ? 'app.collapseTopbar' : 'app.expandTopbar')}
          aria-label={t(collapseControl.sidebar ? 'app.hideSidebar' : collapseControl.kind === 'collapse' ? 'app.collapseTopbar' : 'app.expandTopbar')}
          className={actionClass}
        >
          {collapseControl.sidebar ? <PanelLeftClose className="h-4 w-4" aria-hidden /> : collapseControl.kind === 'collapse' ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
        </Button>
      ) : null}
    </div>
  )
}

function AccountMenu({ account, loading, onSignOut, onOpenAccount, onOpenAdmin, placement = 'default' }: { account?: AccountProfile; loading: boolean; onSignOut?(): void | Promise<void>; onOpenAccount?(): void; onOpenAdmin?(): void; placement?: 'default' | 'rail' | 'footer' }): JSX.Element {
  const { t } = useTranslation()
  const detailsRef = useRef<HTMLDetailsElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const close = (): void => { setOpen(false) }
  useLayoutEffect(() => {
    if (!open) return
    const positionMenu = (): void => {
      const anchor = detailsRef.current?.querySelector('summary')?.getBoundingClientRect()
      const menu = menuRef.current
      if (!anchor || !menu) return
      const width = Math.min(288, window.innerWidth - 16)
      const height = menu.getBoundingClientRect().height
      const left = placement === 'rail' ? anchor.right + 8 : anchor.right - width
      const top = placement === 'default' ? anchor.bottom + 8 : anchor.top - height - 8
      setPosition({
        left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
      })
    }
    positionMenu()
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
    return () => {
      window.removeEventListener('resize', positionMenu)
      window.removeEventListener('scroll', positionMenu, true)
    }
  }, [open, placement])
  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const dismiss = (event: PointerEvent): void => {
      if (event.target instanceof Node && !detailsRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        detailsRef.current?.querySelector('summary')?.focus()
      }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  const prepareNativeSignOut = (): void => {
    // Changing auth state during submit can unmount the form before the browser
    // commits its authoritative POST navigation. Clean up only after pagehide.
    if (!onSignOut) return
    window.addEventListener('pagehide', () => { void onSignOut() }, { once: true })
  }
  return (
    <details ref={detailsRef} open={open} className={cn('relative min-w-0', placement === 'footer' && 'flex-1')} data-testid="account-menu">
      <summary onClick={(event) => { event.preventDefault(); setOpen(!open) }} className={cn('flex cursor-pointer list-none items-center gap-2 rounded-lg text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden', placement === 'footer' ? 'min-h-11 w-full justify-start px-2' : placement === 'rail' ? 'h-11 w-11 justify-center' : 'h-8 min-w-8 justify-center px-1')} aria-haspopup="menu" aria-expanded={open} aria-label={account ? t('appShell.account.trigger', { name: account.displayName }) : t('appShell.account.loading')} data-testid="account-menu-trigger">
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden>{loading ? <span className="text-caption">…</span> : <UserRound className="h-4 w-4" />}</span>
        {account && placement !== 'rail' ? <span className={cn('min-w-0 truncate text-sm font-medium text-foreground', placement === 'footer' ? 'flex-1 text-left' : 'hidden max-w-32 lg:inline')}>{account.displayName}</span> : null}
      </summary>
      {open ? createPortal(<div ref={menuRef} style={{ ...position, width: 'min(18rem, calc(100vw - 1rem))', maxHeight: 'calc(100dvh - 1rem)' }} className="fixed z-50 overflow-hidden rounded-xl border border-border/45 bg-popover text-popover-foreground shadow-lg" role="menu">
        <ScrollArea viewportClassName="max-h-[calc(100dvh-1rem)]">
        <div className="border-b border-border/60 px-4 py-3" data-testid="account-identity-summary"><div className="truncate text-sm font-semibold">{account?.displayName ?? t('appShell.account.loadingLong')}</div>{account?.email ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{account.email}</div> : null}</div>
        <div className="p-1.5">
          <a href="#/docs" role="menuitem" onClick={close} className="flex min-h-11 items-center gap-2 rounded-md px-3 text-sm hover:bg-accent"><CircleHelp className="h-4 w-4" aria-hidden />{t('appShell.account.help')}</a>
          <button type="button" role="menuitem" onClick={() => { close(); onOpenAccount?.() }} data-testid="account-details" className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-accent"><UserRound className="h-4 w-4" aria-hidden />{t('appShell.account.details')}</button>
          {onOpenAdmin ? <button type="button" role="menuitem" onClick={() => { close(); onOpenAdmin() }} data-testid="organization-admin" className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-accent"><SettingsIcon className="h-4 w-4" aria-hidden />{t('appShell.account.administration')}</button> : null}
          <div className="px-3 py-2 text-caption text-muted-foreground">Kala · {t('appShell.account.routing')}</div>
          <form method="post" action="/auth/logout" onSubmit={prepareNativeSignOut}>
            <button type="submit" role="menuitem" data-testid="account-sign-out" className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-destructive hover:bg-destructive/10"><LogOut className="h-4 w-4" aria-hidden />{t('appShell.account.signOut')}</button>
          </form>
        </div>
        </ScrollArea>
      </div>, document.body) : null}
    </details>
  )
}
