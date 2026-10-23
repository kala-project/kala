import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Bug, CalendarClock, Files, GitBranch, Monitor, PanelRightClose, SquareTerminal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RightPanelTab } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import { cn } from '../../lib/utils.js'

export type { RightPanelTab } from '@agent-kernel/shared'

export function RightPanel({
  activeTab,
  onTabChange,
  onCollapse,
  files,
  git,
  terminal,
  inspector,
  scheduledTasks,
  computer,
  headerHelp,
}: {
  activeTab: RightPanelTab
  onTabChange(tab: RightPanelTab): void
  onCollapse(): void
  files: ReactNode
  git: ReactNode
  terminal: ReactNode
  inspector: ReactNode
  scheduledTasks: ReactNode
  computer?: ReactNode
  headerHelp?: ReactNode
}): JSX.Element {
  const { t } = useTranslation()
  const tabsRef = useRef<HTMLDivElement | null>(null)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const [showLabels, setShowLabels] = useState(true)
  const updateLabelVisibility = useCallback((): void => {
    const tabs = tabsRef.current
    const measure = measureRef.current
    if (!tabs || !measure || tabs.clientWidth <= 0) return
    setShowLabels(measure.scrollWidth <= tabs.clientWidth)
  }, [])
  const tabLabels = [t('rightPanel.files'), t('rightPanel.git'), t('rightPanel.terminal'), t('rightPanel.inspector'), t('rightPanel.scheduledTasks'), t('rightPanel.computer')]
  const tabLabelsKey = tabLabels.join('\u0000')
  useEffect(() => {
    updateLabelVisibility()
    const tabs = tabsRef.current
    const measure = measureRef.current
    if (!tabs || !measure || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateLabelVisibility)
    observer.observe(tabs)
    observer.observe(measure)
    return () => observer.disconnect()
  }, [tabLabelsKey, updateLabelVisibility])
  return (
    <div className="flex h-full min-h-0 flex-col bg-card/80 text-card-foreground" data-testid="right-panel">
      <div className="flex h-14 min-w-0 flex-none items-center gap-1 overflow-hidden border-b border-border/35 bg-card/70 px-2 backdrop-blur sm:h-12">
        <div ref={tabsRef} className="ak-segmented-control relative grid min-w-0 flex-1 grid-cols-6 gap-0.5" data-testid="right-panel-tabs" data-labels-visible={showLabels} role="tablist" aria-label={t('rightPanel.tools')}>
          <div ref={measureRef} className="pointer-events-none invisible absolute left-0 top-0 flex w-max gap-0.5" aria-hidden="true">
            {tabLabels.map((label) => <span key={label} className="inline-flex h-8 items-center gap-1 px-1.5 text-caption font-medium"><span className="h-3.5 w-3.5" />{label}</span>)}
          </div>
          <TabButton active={activeTab === 'files'} onClick={() => onTabChange('files')} icon={<Files className="h-3.5 w-3.5" />} label={tabLabels[0]!} showLabel={showLabels} testId="right-panel-files-tab" />
          <TabButton active={activeTab === 'git'} onClick={() => onTabChange('git')} icon={<GitBranch className="h-3.5 w-3.5" />} label={tabLabels[1]!} showLabel={showLabels} testId="right-panel-git-tab" />
          <TabButton active={activeTab === 'terminal'} onClick={() => onTabChange('terminal')} icon={<SquareTerminal className="h-3.5 w-3.5" />} label={tabLabels[2]!} showLabel={showLabels} testId="right-panel-terminal-tab" />
          <TabButton active={activeTab === 'inspector'} onClick={() => onTabChange('inspector')} icon={<Bug className="h-3.5 w-3.5" />} label={tabLabels[3]!} showLabel={showLabels} testId="right-panel-inspector-tab" />
          <TabButton active={activeTab === 'scheduledTasks'} onClick={() => onTabChange('scheduledTasks')} icon={<CalendarClock className="h-3.5 w-3.5" />} label={tabLabels[4]!} showLabel={showLabels} testId="right-panel-scheduled-tasks-tab" />
          <TabButton active={activeTab === 'computer'} onClick={() => onTabChange('computer')} icon={<Monitor className="h-3.5 w-3.5" />} label={tabLabels[5]!} showLabel={showLabels} testId="right-panel-computer-tab" />
        </div>
        {headerHelp}
        <span className="ml-1 h-5 w-px flex-none bg-border/40" aria-hidden="true" />
        <Button variant="ghost" size="icon" className="h-11 w-11 flex-none rounded-lg text-muted-foreground hover:bg-accent/70 hover:text-foreground sm:h-8 sm:w-8" onClick={onCollapse} title={t('rightPanel.collapse')} aria-label={t('rightPanel.collapse')} data-testid="right-panel-collapse"><PanelRightClose className="h-4 w-4" /></Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <PanelContent active={activeTab === 'files'} testId="right-panel-files-content">{files}</PanelContent>
        <PanelContent active={activeTab === 'git'} testId="right-panel-git-content">{git}</PanelContent>
        <PanelContent active={activeTab === 'terminal'} testId="right-panel-terminal-content">{terminal}</PanelContent>
        <PanelContent active={activeTab === 'inspector'} testId="right-panel-inspector-content">{inspector}</PanelContent>
        <PanelContent active={activeTab === 'scheduledTasks'} testId="right-panel-scheduled-tasks-content">{scheduledTasks}</PanelContent>
        <PanelContent active={activeTab === 'computer'} testId="right-panel-computer-content">{computer}</PanelContent>
      </div>
    </div>
  )
}

function PanelContent({ active, testId, children }: { active: boolean; testId: string; children: ReactNode }): JSX.Element {
  // Keep inactive tools mounted so terminal processes and file state survive tab
  // switches, but remove their entire subtree from layout and hit testing.
  // `visibility: hidden` is insufficient because descendants may explicitly set
  // `visibility: visible`, which previously left Inspector covering Terminal.
  return <div className={cn('absolute inset-0 min-h-0 overflow-hidden', !active && 'hidden')} aria-hidden={!active} data-testid={testId}>{children}</div>
}

function TabButton({ active, onClick, icon, label, showLabel, testId }: { active: boolean; onClick(): void; icon: ReactNode; label: string; showLabel: boolean; testId: string }): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={showLabel ? undefined : label}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'inline-flex h-11 w-full min-w-0 items-center justify-center gap-1 rounded-lg px-1 text-caption font-medium transition-all sm:h-8 sm:px-1.5',
        active
          ? 'bg-card text-foreground shadow-sm ring-1 ring-border/45'
          : 'text-muted-foreground hover:bg-card/55 hover:text-foreground',
      )}
    >
      {icon}{showLabel ? <span className="whitespace-nowrap">{label}</span> : null}
    </button>
  )
}
