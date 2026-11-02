import { useEffect, useState, type FormEvent } from 'react'
import {
  Bell,
  Bot,
  Cable,
  Cpu,
  ChevronDown,
  Search,
  Settings,
  Mic,
  Palette,
  PlugZap,
  Rocket,
  ServerCog,
  Shield,
  Database,
  SlidersHorizontal,
  TerminalSquare,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { AttachedExecutor, DashboardClientToServerEvents, DashboardServerToClientEvents, ServerSettingsPayload } from '@agent-kernel/shared'
import type { Socket } from 'socket.io-client'

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  dialogMobileSheetClassName,
  dialogTouchCloseClassName,
} from '../../components/ui/dialog.js'
import { cn } from '../../lib/utils.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { ProductState } from '../../components/ui/product-state.js'
import type { DurableSessionViewCache } from '../../durable-session-cache.js'
import { SettingsSectionButton, SettingsSectionHelpContext } from './controls.js'
import { HelpHint } from '../../components/ui/help-hint.js'
import { useMinWidth } from '../../app-logic/use-viewport.js'
import { AgentSection } from './sections/AgentSection.js'
import { ConnectionSection } from './sections/ConnectionSection.js'
import { DeploymentSection } from './sections/DeploymentSection.js'
import { ExecutorAccessSection } from './sections/ExecutorAccessSection.js'
import { HooksSection } from './sections/HooksSection.js'
import { InterfaceSection } from './sections/InterfaceSection.js'
import { McpSection } from './sections/McpSection.js'
import { ModelsSection } from './sections/ModelsSection.js'
import { NotificationsSection } from './sections/NotificationsSection.js'
import { RuntimeSection } from './sections/RuntimeSection.js'
import { SecuritySection } from './sections/SecuritySection.js'
import { SocketAdminSection } from './sections/SocketAdminSection.js'
import { WebSearchSection } from './sections/WebSearchSection.js'
import { SpeechSection } from './sections/SpeechSection.js'
import { StorageSection } from './sections/StorageSection.js'


type Props = {
  open: boolean
  /** Includes the authenticated identity; prevents cross-organization Settings cache reuse. */
  cacheNamespace?: string
  autoHideOfflineWorkspacesByDefault?: boolean
  onOpenChange(open: boolean): void
  onModelsChanged?(): void
  executors?: readonly AttachedExecutor[]
  sessionCache?: DurableSessionViewCache
  host?: string
  token?: string
  initialSection?: SectionKey
  storageSocket?: Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>
}

type SectionKey = 'runtime' | 'connection' | 'agent' | 'models' | 'webSearch' | 'speech' | 'security' | 'socketAdmin' | 'executorAccess' | 'mcp' | 'hooks' | 'interface' | 'deployment' | 'notifications' | 'storage'

type SectionGroup = 'personal' | 'workspace' | 'agent' | 'administration'
const SECTION_GROUPS: readonly SectionGroup[] = ['personal', 'workspace', 'agent', 'administration']
const SECTIONS: readonly { key: SectionKey; label: string; hint: string; icon: LucideIcon; group: SectionGroup }[] = [
  { key: 'interface', label: 'settings.sections.interface.label', hint: 'settings.sections.interface.hint', icon: Palette, group: 'personal' },
  { key: 'notifications', label: 'settings.sections.notifications.label', hint: 'settings.sections.notifications.hint', icon: Bell, group: 'personal' },
  { key: 'executorAccess', label: 'settings.sections.executorAccess.label', hint: 'settings.sections.executorAccess.hint', icon: TerminalSquare, group: 'workspace' },
  { key: 'mcp', label: 'settings.sections.mcp.label', hint: 'settings.sections.mcp.hint', icon: PlugZap, group: 'workspace' },
  { key: 'agent', label: 'settings.sections.agent.label', hint: 'settings.sections.agent.hint', icon: Bot, group: 'agent' },
  { key: 'models', label: 'settings.sections.models.label', hint: 'settings.sections.models.hint', icon: Cpu, group: 'agent' },
  { key: 'webSearch', label: 'settings.sections.webSearch.label', hint: 'settings.sections.webSearch.hint', icon: Search, group: 'agent' },
  { key: 'speech', label: 'settings.sections.speech.label', hint: 'settings.sections.speech.hint', icon: Mic, group: 'agent' },
  { key: 'connection', label: 'settings.sections.connection.label', hint: 'settings.sections.connection.hint', icon: Cable, group: 'administration' },
  { key: 'security', label: 'settings.sections.security.label', hint: 'settings.sections.security.hint', icon: Shield, group: 'administration' },
  { key: 'socketAdmin', label: 'settings.sections.socketAdmin.label', hint: 'settings.sections.socketAdmin.hint', icon: ServerCog, group: 'administration' },
  { key: 'hooks', label: 'settings.sections.hooks.label', hint: 'settings.sections.hooks.hint', icon: PlugZap, group: 'administration' },
  { key: 'runtime', label: 'settings.sections.runtime.label', hint: 'settings.sections.runtime.hint', icon: SlidersHorizontal, group: 'administration' },
  { key: 'storage', label: 'settings.sections.storage.label', hint: 'settings.sections.storage.hint', icon: Database, group: 'administration' },
  { key: 'deployment', label: 'settings.sections.deployment.label', hint: 'settings.sections.deployment.hint', icon: Rocket, group: 'administration' },
]

export function SettingsDialog({ open, cacheNamespace = 'default', autoHideOfflineWorkspacesByDefault = true, onOpenChange, onModelsChanged, executors = [], sessionCache, host = '', token, initialSection = 'connection', storageSocket }: Props): JSX.Element {
  const { t } = useTranslation()
  const desktopLayout = useMinWidth(768)
  const queryClient = useQueryClient()
  const [section, setSection] = useState<SectionKey>(initialSection)
  const [sectionHelp, setSectionHelp] = useState<string>()
  const activeSection = SECTIONS.find((item) => item.key === section) ?? SECTIONS[0]!

  const settingsQuery = useQuery({
    queryKey: ['settings', cacheNamespace],
    queryFn: async (): Promise<ServerSettingsPayload> => {
      const r = await fetch('/settings', { cache: 'no-store' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as ServerSettingsPayload
    },
    enabled: open,
    staleTime: 30_000,
  })
  const payload = settingsQuery.data ?? null
  const loadError = settingsQuery.error ? (settingsQuery.error as Error).message : null

  const applyPayload = (next: ServerSettingsPayload): void => {
    queryClient.setQueryData(['settings', cacheNamespace], next)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(dialogMobileSheetClassName, 'h-auto grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] border-x-0 border-border/60 bg-background text-foreground shadow-2xl sm:h-[min(90dvh,46rem)] sm:max-w-5xl sm:overflow-hidden sm:rounded-2xl sm:border-x [&_input]:border-border/50 [&_input]:bg-card/70 [&_input]:text-foreground [&_select]:border-border/50 [&_select]:bg-card/70 [&_select]:text-foreground [&_table]:bg-muted/10 [&_td]:text-foreground [&_textarea]:border-border/50 [&_textarea]:bg-card/70 [&_textarea]:text-foreground [&_th]:bg-muted/30 [&_th]:text-foreground')}
        data-testid="settings-dialog"
      >
        <DialogHeader className="relative min-h-[4.5rem] min-w-0 justify-center border-b border-border/40 bg-card/75 px-4 py-2 pr-14 backdrop-blur md:min-h-0 md:px-6 md:py-4 md:pr-14">
          <div className={desktopLayout ? 'hidden' : undefined}>
            <div className="flex items-center gap-1.5 text-caption font-medium uppercase tracking-[0.14em] text-muted-foreground"><Settings className="h-3.5 w-3.5" aria-hidden="true" data-testid="settings-title-icon" />{t('settings.title')}</div>
            <div className="flex min-w-0 items-center gap-1">
            <label className="relative mt-0.5 inline-flex min-w-0 max-w-full flex-1 items-center gap-2 pr-6" data-testid="settings-mobile-section-picker">
              <span className="sr-only">{t('settings.sectionsLabel')}</span>
              <span className="truncate text-lg font-semibold leading-6 text-foreground">{t(activeSection.label)}</span>
              <ChevronDown className="pointer-events-none absolute right-0 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <select
                value={section}
                onChange={(event) => setSection(event.target.value as SectionKey)}
                className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
                aria-label={t('settings.sectionsLabel')}
                data-testid="settings-mobile-section-select"
              >
                {SECTIONS.map((item) => <option key={item.key} value={item.key}>{t(item.label)}</option>)}
              </select>
            </label>
            <HelpHint key={section} label={t(activeSection.label)}><span className="block">{t(activeSection.hint)}</span>{sectionHelp ? <span className="mt-2 block">{sectionHelp}</span> : null}</HelpHint>
            </div>
          </div>
          <div className={desktopLayout ? undefined : 'hidden'}>
            <DialogTitle className="flex items-center gap-1.5 text-base font-semibold text-foreground"><Settings className="h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" data-testid="settings-title-icon" />{t('settings.title')}<HelpHint label={t('settings.title')}>{t('settings.description')}</HelpHint></DialogTitle>
          </div>
          <DialogDescription className="sr-only">{t('common.contextualHelp')}</DialogDescription>
          <DialogClose
            className={dialogTouchCloseClassName}
            aria-label={t('common.close')}
            data-testid="settings-dialog-close"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </DialogClose>
        </DialogHeader>
        <div className={cn('grid min-h-0 min-w-0', desktopLayout && 'grid-cols-[14.5rem_minmax(0,1fr)]')}>
          <aside className={cn('min-h-0 min-w-0 border-r border-border/35 bg-muted/15', !desktopLayout && 'hidden')}>
            <ScrollArea className="h-full overflow-x-hidden" aria-label={t('settings.sectionsLabel')} contentClassName="space-y-4 px-3 py-4 min-w-full" role="navigation">
              {SECTION_GROUPS.map((group) => (
                <div key={group} className="space-y-1" data-testid={`settings-group-${group}`}>
                  <div className="px-2 pb-1 text-caption font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
                    {t(`settings.groups.${group}`)}
                  </div>
                  <div className="ml-2 space-y-0.5 border-l border-border/45 pl-2" data-testid={`settings-group-items-${group}`}>
                    {SECTIONS.filter((item) => item.group === group).map((item) => (
                      <SettingsSectionButton key={item.key} section={item} active={section === item.key} onClick={() => setSection(item.key)} />
                    ))}
                  </div>
                </div>
              ))}
            </ScrollArea>
          </aside>
          <ScrollArea
            className="ak-workspace-canvas min-h-0 min-w-0 max-w-full overflow-x-hidden"
            viewportClassName="[&>div]:!block [&>div]:!w-full [&>div]:!min-w-0 [&>div]:!max-w-full"
          >
            <div className="mx-auto min-w-0 max-w-full overflow-x-hidden px-4 py-5 pb-[max(env(safe-area-inset-bottom),1.25rem)] text-foreground md:max-w-3xl md:p-8" data-testid="settings-responsive-content">
              <SettingsSectionHelpContext.Provider value={setSectionHelp}>
              {loadError ? (
                <ProductState kind="error" title={t('settings.loadErrorTitle')} description={t('settings.loadFailed', { error: loadError })} primary={{ label: t('common.retry'), onClick: () => { void settingsQuery.refetch() } }} />
              ) : payload === null ? (
                <ProductState kind="loading" title={t('settings.loadingTitle')} description={t('settings.loadingDescription')} />
              ) : section === 'runtime' ? (
                <RuntimeSection payload={payload} />
              ) : section === 'storage' ? (
                <StorageSection socket={storageSocket} payload={payload} />
              ) : section === 'connection' ? (
                <ConnectionSection />
              ) : section === 'agent' ? (
                <AgentSection payload={payload} onPayloadChange={applyPayload} />
              ) : section === 'models' ? (
                <ModelsSection payload={payload} onPayloadChange={applyPayload} onModelsChanged={onModelsChanged} />
              ) : section === 'webSearch' ? (
                <WebSearchSection />
              ) : section === 'speech' ? (
                <SpeechSection />
              ) : section === 'security' ? (
                <SecuritySection payload={payload} />
              ) : section === 'socketAdmin' ? (
                <SocketAdminSection payload={payload} onPayloadChange={applyPayload} socket={storageSocket} />
              ) : section === 'executorAccess' ? (
                <ExecutorAccessSection executors={executors} />
              ) : section === 'mcp' ? (
                <McpSection executors={executors} token={token} />
              ) : section === 'hooks' ? (
                <HooksSection payload={payload} />
              ) : section === 'interface' ? (
                <InterfaceSection sessionCache={sessionCache} autoHideOfflineWorkspacesByDefault={autoHideOfflineWorkspacesByDefault} />
              ) : section === 'deployment' ? (
                <DeploymentSection payload={payload} host={host} token={token} />
              ) : (
                <NotificationsSection />
              )}
              </SettingsSectionHelpContext.Provider>
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Web Push (background) subscription toggle. Sits below the foreground
 * desktop-notification prefs and reuses the same per-kind toggles so the
 * server dispatches the same categories the user already opted in to.
 *
 * Kept separate from DesktopNotificationsSettings because feature detection,
 * subscription state, and iOS-standalone gating are all specific to Push
 * and would clutter the foreground path.
 */
