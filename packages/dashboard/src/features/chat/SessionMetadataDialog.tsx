import { ScrollArea } from '../../components/ui/scroll-area.js'
/**
 * Read-only + editable "session info" modal opened from the workbench toolbar.
 *
 * Read-only rows show what the operator can't change (sessionId, parent,
 * timestamps, workspace, executor, activity counters). Label and approval
 * mode are draft edits committed by the Save button. CWD still opens the
 * dedicated directory picker because it has its own validation flow.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HelpHint } from '../../components/ui/help-hint.js'
import { Link2, RefreshCw, Trash2, X } from 'lucide-react'
import type { Socket } from 'socket.io-client'

import type { AgentState } from '@agent-kernel/kernel'
import type { ApprovalMode } from '@agent-kernel/kernel'
import type {
  ContextUsageSnapshot,
  DashboardClientToServerEvents,
  DashboardServerToClientEvents,
  SessionStorageSnapshot,
  StorageCleanupPlanPreview,
  SessionSummary,
  ToolCardMode,
} from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  dialogMobileSheetClassName,
  dialogTouchCloseClassName,
} from '../../components/ui/dialog.js'
import { cn } from '../../lib/utils.js'
import { saveFile } from '../../lib/save-file.js'
import { getDesktopBridge, validDesktopSessionId } from '../../lib/desktop-bridge.js'
import { writeTextToClipboard } from '../../lib/clipboard.js'
import { notify } from '../../notify.js'
import { evaluationReferenceUrl, explicitEvaluationReference, governedSessionTaskCandidate } from '../../evaluation-integration.js'
import { Input } from '../../components/ui/input.js'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js'

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  sessionId: string
  summary?: SessionSummary & { costUsd?: number | null }
  state: AgentState | null
  contextSnapshot?: ContextUsageSnapshot | null
  selectedModel: string | null
  executorHost?: string
  evaluationUrl?: string
  onRename(label: string): void
  onOpenChangeCwdDialog(): void
  onChangeApprovalMode(mode: ApprovalMode): void
  onChangeToolCardMode(mode: ToolCardMode): void
  canChangeCwd?: boolean
  canChangeApprovalMode?: boolean
  storageSocket?: Socket<DashboardServerToClientEvents, DashboardClientToServerEvents>
}

const APPROVAL_MODE_ITEMS: ReadonlyArray<{ value: ApprovalMode; labelKey: string }> = [
  { value: 'auto', labelKey: 'dialogs.approvalModes.auto' },
  { value: 'ask', labelKey: 'dialogs.approvalModes.ask' },
  { value: 'deny', labelKey: 'dialogs.approvalModes.deny' },
  { value: 'allow_all', labelKey: 'dialogs.approvalModes.allowAll' },
]

export function SessionMetadataDialog({
  open,
  onOpenChange,
  sessionId,
  summary,
  state,
  contextSnapshot,
  selectedModel,
  executorHost,
  evaluationUrl,
  onRename,
  onOpenChangeCwdDialog,
  onChangeApprovalMode,
  onChangeToolCardMode,
  canChangeCwd = true,
  canChangeApprovalMode = true,
  storageSocket,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const initialLabel = summary?.label ?? ''
  const initialCwd = state?.cwd ?? summary?.currentCwd ?? ''
  const approvalMode = state?.approvalMode ?? 'auto'
  const toolCardMode = summary?.preferences?.toolCardMode ?? 'dots'
  const agentRuntime = summary?.agentRuntime ?? 'kernel'
  const canUpgradeTools = canChangeApprovalMode && (state?.status === 'idle' || state?.status === 'done' || state?.status === 'error')
  const agentRuntimeLabel = agentRuntime === 'copilot'
    ? 'GitHub Copilot SDK'
    : 'Agent Kernel'
  const agentRuntimeDisplay = `${agentRuntimeLabel} (${agentRuntime})${summary?.agentRuntimeVersion ? ` · v${summary.agentRuntimeVersion}` : ''}`
  const directContextTokens = contextSnapshot?.usage.totalTokens
  const directInputTokens = state?.usage.inputTokens
  const directOutputTokens = state?.usage.outputTokens

  const [labelDraft, setLabelDraft] = useState(initialLabel)
  const [approvalDraft, setApprovalDraft] = useState<ApprovalMode>(approvalMode)
  const [toolCardModeDraft, setToolCardModeDraft] = useState<ToolCardMode>(toolCardMode)
  const [activeTab, setActiveTab] = useState<'overview' | 'statistics' | 'storage'>('overview')
  const [numberDisplay, setNumberDisplay] = useState<'compact' | 'exact'>(() => {
    if (typeof window === 'undefined') return 'compact'
    return window.localStorage.getItem('ak-session-statistics-number-display') === 'exact' ? 'exact' : 'compact'
  })
  const [storage, setStorage] = useState<SessionStorageSnapshot | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  const [selectedStorageIds, setSelectedStorageIds] = useState<ReadonlySet<string>>(new Set())
  const [cleanupPlans, setCleanupPlans] = useState<readonly StorageCleanupPlanPreview[]>([])
  const [cleanupConfirmationStep, setCleanupConfirmationStep] = useState<'review' | 'final'>('review')
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [toolUpgrades, setToolUpgrades] = useState<readonly string[]>([])
  const [selectedTools, setSelectedTools] = useState<ReadonlySet<string>>(new Set())
  const [toolUpgradeReview, setToolUpgradeReview] = useState(false)
  const [toolUpgradeBusy, setToolUpgradeBusy] = useState(false)
  const [toolUpgradeError, setToolUpgradeError] = useState<string | null>(null)
  const toolUpgradeSessionRef = useRef(sessionId)
  toolUpgradeSessionRef.current = sessionId

  useEffect(() => {
    setToolUpgrades([])
    setSelectedTools(new Set())
    setToolUpgradeReview(false)
    setToolUpgradeBusy(false)
    setToolUpgradeError(null)
    if (!open || !storageSocket || summary?.parentSessionId) return
    let active = true
    storageSocket.emit('client:list_session_tool_upgrades', { sessionId }, (result) => {
      if (!active) return
      if (result.ok) setToolUpgrades(result.value)
      else setToolUpgradeError(result.error)
    })
    return () => { active = false }
  }, [open, sessionId, storageSocket, summary?.parentSessionId])

  const enableSelectedTools = (): void => {
    if (!storageSocket || selectedTools.size === 0 || !toolUpgradeReview || toolUpgradeBusy) return
    setToolUpgradeBusy(true)
    setToolUpgradeError(null)
    storageSocket.emit('client:upgrade_session_tools', { sessionId, tools: [...selectedTools] }, (result) => {
      if (toolUpgradeSessionRef.current !== sessionId) return
      setToolUpgradeBusy(false)
      if (!result.ok) { setToolUpgradeError(result.error); return }
      setToolUpgrades((current) => current.filter((tool) => !result.value.includes(tool)))
      setSelectedTools(new Set())
      setToolUpgradeReview(false)
      notify.success(t('sessionMetadata.toolUpgrades.success'))
    })
  }

  const loadStorage = (refresh: boolean): void => {
    if (!storageSocket || !sessionId) return
    setStorageLoading(true)
    setStorageError(null)
    storageSocket.emit('client:get_session_storage', { sessionId, ...(refresh ? { refresh: true } : {}) }, (result) => {
      setStorageLoading(false)
      if (result.ok) setStorage(result.value)
      else setStorageError(result.error)
    })
  }

  const prepareSubagentCleanup = async (): Promise<void> => {
    if (!storageSocket || !storage || selectedStorageIds.size === 0) return
    const targetIds = topLevelSelectedSessionIds(selectedStorageIds, storage.descendants)
    setCleanupBusy(true)
    setStorageError(null)
    try {
      const plans = await Promise.all(targetIds.map((targetId) => new Promise<StorageCleanupPlanPreview>((resolve, reject) => {
        storageSocket.emit('client:prepare_storage_cleanup', { operation: 'subagent-details', targetId }, (result) => {
          if (result.ok) resolve(result.value)
          else reject(new Error(result.error))
        })
      })))
      setCleanupPlans(plans)
      setCleanupConfirmationStep('review')
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : String(error))
    } finally {
      setCleanupBusy(false)
    }
  }

  const executeCleanup = async (): Promise<void> => {
    if (!storageSocket || cleanupPlans.length === 0) return
    setCleanupBusy(true)
    setStorageError(null)
    let completed = 0
    for (const plan of cleanupPlans) {
      const result = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
        storageSocket.emit('client:execute_storage_cleanup', { planId: plan.planId }, (value) => {
          resolve(value.ok ? { ok: true } : value)
        })
      })
      if (!result.ok) {
        setStorageError(
          completed > 0
            ? `${completed} cleanup ${completed === 1 ? 'plan completed' : 'plans completed'} before the remaining operation failed: ${result.error}`
            : result.error,
        )
        setCleanupPlans([])
        setCleanupConfirmationStep('review')
        setCleanupBusy(false)
        setSelectedStorageIds(new Set())
        loadStorage(true)
        return
      }
      completed += 1
    }
    setCleanupPlans([])
    setCleanupConfirmationStep('review')
    setCleanupBusy(false)
    setSelectedStorageIds(new Set())
    loadStorage(true)
  }

  useEffect(() => {
    if (open) {
      setLabelDraft(initialLabel)
      setApprovalDraft(approvalMode)
      setToolCardModeDraft(toolCardMode)
      setActiveTab('overview')
      setSelectedStorageIds(new Set())
      setCleanupPlans([])
      setCleanupConfirmationStep('review')
      loadStorage(false)
    }
  }, [open, initialLabel, approvalMode, toolCardMode, sessionId, storageSocket])

  const labelChanged = labelDraft.trim() !== (summary?.label ?? '').trim()
  const approvalChanged = approvalDraft !== approvalMode
  const toolCardModeChanged = toolCardModeDraft !== toolCardMode
  const canSave = labelChanged || approvalChanged || toolCardModeChanged
  const selectedBytes = storage?.descendants
    .filter((entry) => selectedStorageIds.has(entry.sessionId))
    .reduce((total, entry) => total + entry.directBytes, 0) ?? 0
  const allStorageSelected = Boolean(storage?.descendants.length)
    && storage!.descendants.every((entry) => selectedStorageIds.has(entry.sessionId))
  const someStorageSelected = selectedStorageIds.size > 0 && !allStorageSelected
  const plannedBytes = cleanupPlans.reduce((total, plan) => total + plan.estimatedBytes, 0)
  const plannedItems = cleanupPlans.reduce((total, plan) => total + plan.itemCount, 0)
  const plannedSessions = new Set(cleanupPlans.flatMap((plan) => plan.sessionIds)).size
  const evaluationReference = typeof window === 'undefined' ? undefined : explicitEvaluationReference(window.location, sessionId)
  const desktopSessionLink = getDesktopBridge() && validDesktopSessionId(sessionId) ? `agent-runlab://session/${sessionId}` : null
  const copyDesktopSessionLink = async (): Promise<void> => {
    if (!desktopSessionLink) return
    try {
      await writeTextToClipboard(desktopSessionLink)
      notify.success(t('common.copied'), { id: 'desktop-session-link' })
    } catch (error) {
      notify.error(t('desktopNative.copyLinkFailed'), {
        id: 'desktop-session-link',
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const exportTaskCandidate = async (): Promise<void> => {
    const candidate = governedSessionTaskCandidate(sessionId, summary, selectedModel)
    await saveFile({ suggestedName: 'agent-eval-task-candidate-' + sessionId.replace(/[^A-Za-z0-9._:-]/gu, '-') + '.json', blob: new Blob([JSON.stringify(candidate, null, 2) + '\n'], { type: 'application/json' }), mimeType: 'application/json' })
  }

  const save = (): void => {
    const nextLabel = labelDraft.trim()
    if (labelChanged) onRename(nextLabel)
    if (approvalChanged) onChangeApprovalMode(approvalDraft)
    if (toolCardModeChanged) onChangeToolCardMode(toolCardModeDraft)
    onOpenChange(false)
  }
  const setStatisticsNumberDisplay = (value: 'compact' | 'exact'): void => {
    setNumberDisplay(value)
    if (typeof window !== 'undefined') window.localStorage.setItem('ak-session-statistics-number-display', value)
  }
  const formatStatistic = (value: number): string =>
    numberDisplay === 'exact' ? value.toLocaleString() : formatCompactNumber(value)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="session-metadata-dialog"
        className={cn(dialogMobileSheetClassName, 'grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl')}
      >
        <DialogHeader className="relative border-b border-border/60 px-4 py-3 pr-14 sm:px-6 sm:py-4 sm:pr-14">
          <DialogTitle className="flex items-center gap-1 text-lg">{t('dialogs.sessionInfo')}<HelpHint label={t('dialogs.sessionInfo')}>{t('dialogs.sessionInfoDescription')}</HelpHint></DialogTitle>
          <DialogDescription className="sr-only">{t('common.contextualHelp')}</DialogDescription>
          <ScrollArea className="mt-3" role="tablist" aria-label={t('sessionMetadata.tabs.label')} contentClassName="flex gap-1 min-w-full w-max">
            <MetadataTab active={activeTab === 'overview'} testId="session-info-overview-tab" onClick={() => setActiveTab('overview')}>
              {t('sessionMetadata.tabs.overview')}
            </MetadataTab>
            <MetadataTab active={activeTab === 'statistics'} testId="session-info-statistics-tab" onClick={() => setActiveTab('statistics')}>
              {t('sessionMetadata.tabs.statistics')}
            </MetadataTab>
            <MetadataTab active={activeTab === 'storage'} testId="session-info-storage-tab" onClick={() => setActiveTab('storage')}>
              {t('sessionMetadata.tabs.storage')}
            </MetadataTab>
          </ScrollArea>
          <DialogClose className={dialogTouchCloseClassName} aria-label={t('common.close')}>
            <X className="h-5 w-5" aria-hidden="true" />
          </DialogClose>
        </DialogHeader>

        <DialogBody contentClassName="px-4 py-4 sm:px-6" data-testid="session-metadata-body">
        {activeTab === 'overview' ? (
        <>
        <div className="grid gap-3 text-sm">
          <ReadOnlyRow label={t('dialogs.sessionId')} value={sessionId} mono action={desktopSessionLink ? (
            <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" data-testid="copy-desktop-session-link" aria-label={t('desktopNative.copySessionLink')} title={t('desktopNative.copySessionLink')} onClick={() => void copyDesktopSessionLink()}>
              <Link2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          ) : null} />
          <ReadOnlyRow
            label={t('dialogs.agentRuntime')}
            value={agentRuntimeDisplay}
            testId="session-metadata-agent-runtime"
          />
          {summary?.parentSessionId ? (
            <ReadOnlyRow
              label={t('dialogs.parentSession')}
              value={summary.parentSessionId}
              mono
            />
          ) : null}
          <ReadOnlyRow
            label={t('dialogs.workspace')}
            value={
              summary?.workspaceName
                ? `${summary.workspaceName}${summary.workspaceId ? ` · ${summary.workspaceId.slice(0, 8)}` : ''}`
                : summary?.workspaceId ?? t('dialogs.unassigned')
            }
          />
          {executorHost ? (
            <ReadOnlyRow label={t('dialogs.executorHost')} value={executorHost} />
          ) : null}
          <ReadOnlyRow
            label={t('common.model')}
            value={selectedModel ?? t('dialogs.defaultModel')}
            mono
          />
        </div>

        <div className="border-t border-border/50 pt-3" />

        <section className="grid gap-2 text-sm" aria-label={t('sessionMetadata.evaluation')}>
          <span className="text-xs uppercase tracking-wider text-muted-foreground">{t('sessionMetadata.evaluation')}</span>
          <p className="text-xs text-muted-foreground">{t('sessionMetadata.evaluationDescription')}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" data-testid="session-export-task-candidate" onClick={() => void exportTaskCandidate()}>{t('sessionMetadata.exportCandidate')}</Button>
            {evaluationReference && evaluationUrl ? <Button type="button" variant="outline" size="sm" asChild><a data-testid="session-open-evaluation-reference" href={evaluationReferenceUrl(evaluationReference, evaluationUrl)} target="_blank" rel="noreferrer">{t('sessionMetadata.openEvidence')}</a></Button> : null}
          </div>
        </section>

        <div className="border-t border-border/50 pt-3" />

        <div className="grid gap-4 text-sm">
          <FieldRow label={t('dialogs.label')} htmlFor="session-metadata-label">
            <Input
              id="session-metadata-label"
              className="text-base sm:text-sm"
              data-testid="session-metadata-label"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (canSave) save()
                }
              }}
              placeholder={t('dialogs.clearOverridePlaceholder')}
            />
          </FieldRow>
          <FieldRow label={t('dialogs.workingDirectory')} htmlFor="session-metadata-cwd">
            <div className="flex items-center gap-2">
              <div
                id="session-metadata-cwd"
                data-testid="session-metadata-cwd"
                className="min-w-0 flex-1 truncate rounded-md border border-input bg-muted/40 px-3 py-2 font-mono text-xs text-foreground"
                title={initialCwd || t('dialogs.noCwdSet')}
              >
                {initialCwd || (
                  <span className="text-muted-foreground">{t('dialogs.noCwdSet')}</span>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false)
                  onOpenChangeCwdDialog()
                }}
                disabled={!canChangeCwd}
                data-testid="session-metadata-cwd-change"
              >
                {t('dialogs.change')}
              </Button>
            </div>
          </FieldRow>
          <FieldRow label={t('dialogs.approvals')}>
            <Select
              value={approvalDraft}
              onValueChange={(v) => setApprovalDraft(v as ApprovalMode)}
              disabled={!canChangeApprovalMode}
            >
              <SelectTrigger className="h-11 text-base sm:h-8 sm:text-sm" data-testid="session-metadata-approval">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APPROVAL_MODE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {t(item.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label={t('dialogs.toolCardMode')}>
            <Select value={toolCardModeDraft} onValueChange={(value) => setToolCardModeDraft(value as ToolCardMode)}>
              <SelectTrigger className="h-11 text-base sm:h-8 sm:text-sm" data-testid="session-metadata-tool-card-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dots">{t('dialogs.toolCardModes.dots')}</SelectItem>
                <SelectItem value="standard">{t('dialogs.toolCardModes.standard')}</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </div>
        {toolUpgrades.length > 0 && !summary?.parentSessionId ? (
          <details className="border-t border-border/50 pt-3 text-sm" data-testid="session-tool-upgrades">
            <summary className="cursor-pointer font-medium">{t('sessionMetadata.toolUpgrades.title')}</summary>
            <div className="mt-2 grid gap-2">
            <p className="text-xs text-muted-foreground">{t('sessionMetadata.toolUpgrades.description')}</p>
            <div className="flex flex-wrap gap-2">
              {toolUpgrades.map((name) => (
                <label key={name} className="flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 font-mono text-xs">
                  <input type="checkbox" checked={selectedTools.has(name)} disabled={toolUpgradeBusy || toolUpgradeReview || !canUpgradeTools} onChange={(event) => {
                    setSelectedTools((current) => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(name)
                      else next.delete(name)
                      return next
                    })
                  }} />
                  {name}
                </label>
              ))}
            </div>
            {!canUpgradeTools ? <p className="text-xs text-muted-foreground">{t('sessionMetadata.toolUpgrades.unavailable')}</p> : null}
            <div className="flex gap-2">
              {toolUpgradeReview ? (
                <>
                  <Button type="button" size="sm" disabled={toolUpgradeBusy} onClick={enableSelectedTools}>{t('sessionMetadata.toolUpgrades.confirm')} ({[...selectedTools].join(', ')})</Button>
                  <Button type="button" size="sm" variant="outline" disabled={toolUpgradeBusy} onClick={() => setToolUpgradeReview(false)}>{t('sessionMetadata.toolUpgrades.cancel')}</Button>
                </>
              ) : (
                <Button type="button" size="sm" variant="outline" disabled={!canUpgradeTools || selectedTools.size === 0} onClick={() => setToolUpgradeReview(true)}>{t('sessionMetadata.toolUpgrades.review')}</Button>
              )}
            </div>
            </div>
          </details>
        ) : null}
        {toolUpgradeError ? <p role="alert" className="text-xs text-destructive">{toolUpgradeError}</p> : null}
        </>
        ) : activeTab === 'statistics' ? (
        <section className="grid gap-4 text-sm" aria-label={t('sessionMetadata.tabs.statistics')} data-testid="session-statistics">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="font-medium">{t('sessionMetadata.statistics.title')}</h3>
              <p className="text-xs text-muted-foreground">{t('sessionMetadata.statistics.description')}</p>
            </div>
            <div className="inline-flex rounded-md border border-border/60 bg-muted/20 p-0.5" role="group" aria-label={t('sessionMetadata.numberDisplay.label')} data-testid="session-statistics-number-toggle">
              {(['compact', 'exact'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={cn('min-h-7 rounded px-2 text-caption transition-colors', numberDisplay === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                  aria-pressed={numberDisplay === value}
                  aria-label={t(`sessionMetadata.numberDisplay.${value}Aria`)}
                  title={t(`sessionMetadata.numberDisplay.${value}Title`)}
                  data-testid={`session-statistics-number-${value}`}
                  onClick={() => setStatisticsNumberDisplay(value)}
                >
                  {t(`sessionMetadata.numberDisplay.${value}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-hidden rounded-lg border border-border/45 bg-muted/10" data-testid="session-statistics-grid">
            <div className="grid grid-cols-[minmax(7.5rem,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 border-b border-border/45 bg-muted/25 px-3 py-1.5 text-caption font-semibold uppercase tracking-wider text-muted-foreground">
              <span>{t('sessionMetadata.statistics.title')}</span>
              <span>{t('sessionMetadata.statistics.allSessions')}</span>
              <span>{t('sessionMetadata.statistics.thisSession')}</span>
            </div>
            <StatisticsRow
              label={t('sessionMetadata.statistics.currentContext')}
              help={t(storage?.tokenUsage ? 'sessionMetadata.statistics.currentContextHelp' : 'sessionMetadata.statistics.currentContextDirectHelp')}
              allSessions={storage?.tokenUsage ? formatStatistic(storage.tokenUsage.tree.currentContextTokens) : undefined}
              thisSession={storage?.tokenUsage
                ? formatStatistic(storage.tokenUsage.direct.currentContextTokens)
                : directContextTokens !== undefined ? formatStatistic(directContextTokens) : '—'}
            />
            <StatisticsRow
              label={t('sessionMetadata.statistics.cumulativeUsage')}
              help={t(storage?.tokenUsage ? 'sessionMetadata.statistics.cumulativeUsageHelp' : 'sessionMetadata.statistics.cumulativeUsageDirectHelp')}
              allSessions={storage?.tokenUsage ? (
                <TokenPairBadges
                  input={formatStatistic(storage.tokenUsage.tree.cumulativeInputTokens)}
                  output={formatStatistic(storage.tokenUsage.tree.cumulativeOutputTokens)}
                />
              ) : undefined}
              thisSession={storage?.tokenUsage ? (
                <TokenPairBadges
                  input={formatStatistic(storage.tokenUsage.direct.cumulativeInputTokens)}
                  output={formatStatistic(storage.tokenUsage.direct.cumulativeOutputTokens)}
                />
              ) : (
                <TokenPairBadges input={formatStatistic(directInputTokens ?? 0)} output={formatStatistic(directOutputTokens ?? 0)} />
              )}
            />
            <StatisticsRow label={t('dialogs.events')} thisSession={<span data-testid="session-statistics-events">{formatStatistic(summary?.eventCount ?? state?.messages.length ?? 0)}</span>} />
            <StatisticsRow label={t('sessionMetadata.statistics.turns')} thisSession={<span data-testid="session-statistics-turns">{formatStatistic(state?.messages.filter((message) => message.role === 'user').length ?? 0)}</span>} />
            <StatisticsRow label={t('dialogs.created')} thisSession={formatTs(summary?.createdAt)} />
            <StatisticsRow label={t('dialogs.lastActivity')} thisSession={formatTs(summary?.lastEventAt ?? summary?.createdAt)} />
            <StatisticsRow label={t('sessionMetadata.statistics.elapsed')} thisSession={formatElapsed(summary?.createdAt, summary?.lastEventAt)} />
            <StatisticsRow
              label={t('dialogs.sessionCost')}
              thisSession={summary?.costUsd === null || summary?.costUsd === undefined
                ? <span className="text-muted-foreground" data-testid="session-cost-unavailable">{t('sessionMetadata.statistics.costUnavailable')}</span>
                : <span data-testid="session-cost-value">${summary.costUsd.toFixed(2)}</span>}
            />
          </div>
        </section>
        ) : (
        <section className="grid gap-4 text-sm" aria-label="Storage" data-testid="session-storage">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              <h3 className="font-medium">Stored session data</h3>
              <HelpHint label="Stored session data" testId="session-storage-help">
                {storage?.state.source === 'postgres'
                  ? 'Logical bytes of PostgreSQL session snapshots, events, native files, and committed object storage. PostgreSQL indexes, database overhead, and object-storage overhead are not included. Remote cleanup is not available here.'
                  : 'Stored data includes transcripts, runtime events, tool records, snapshots, summaries, context sidecars, and artifacts. Cleaning a sub-agent removes its detailed records and descendants while retaining the graph result and a tombstone.'}
              </HelpHint>
            </div>
            <Button type="button" variant="ghost" size="sm" disabled={storageLoading || !storageSocket || cleanupBusy} onClick={() => loadStorage(true)}>
              <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', storageLoading && 'animate-spin')} aria-hidden />
              Refresh
            </Button>
          </div>
          {storageError ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{storageError === 'storage inventory unavailable' ? t('sessionMetadata.storageUnavailable') : storageError}</p> : null}
          {storage ? (
            <>
              <div className="grid grid-cols-3 gap-2 rounded-md border border-border/50 bg-muted/20 p-3">
                <StorageMetric label="Total" bytes={storage.session.treeBytes} />
                <StorageMetric label="This session" bytes={storage.session.directBytes} />
                <StorageMetric label={`${storage.session.descendantCount} sub-agents`} bytes={Math.max(0, storage.session.treeBytes - storage.session.directBytes)} />
              </div>
              {storage.descendants.length > 0 ? (
                <div className="overflow-hidden rounded-md border border-border/50">
                  <label className="grid min-h-10 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border/50 bg-muted/20 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select all sub-agents"
                      checked={allStorageSelected}
                      ref={(input) => { if (input) input.indeterminate = someStorageSelected }}
                      disabled={storage.state.source === 'postgres' || cleanupBusy || cleanupPlans.length > 0}
                      onChange={(event) => {
                        setSelectedStorageIds(event.target.checked ? new Set(storage.descendants.map((entry) => entry.sessionId)) : new Set())
                      }}
                    />
                    <span className="font-medium">Sub-agent records</span>
                    <span className="text-xs text-muted-foreground">Stored size</span>
                  </label>
                  <div className="divide-y divide-border/40">
                    {storage.descendants.map((entry) => (
                      <label key={entry.sessionId} className="grid min-h-12 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 hover:bg-muted/20">
                        <input
                          type="checkbox"
                          aria-label={`Select ${entry.sessionId}`}
                          checked={selectedStorageIds.has(entry.sessionId)}
                          disabled={storage.state.source === 'postgres' || cleanupBusy || cleanupPlans.length > 0}
                          onChange={(event) => {
                            setSelectedStorageIds((current) => {
                              const next = new Set(current)
                              if (event.target.checked) next.add(entry.sessionId)
                              else next.delete(entry.sessionId)
                              return next
                            })
                          }}
                        />
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs" title={entry.sessionId}>{entry.sessionId}</div>
                          <div className="text-caption text-muted-foreground">
                            {entry.descendantCount > 0 ? `Sub-agent with ${entry.descendantCount} descendants` : 'Sub-agent'} · {formatBytes(entry.treeBytes)} including descendants
                          </div>
                        </div>
                        <span className="shrink-0 text-xs">{formatBytes(entry.directBytes)}</span>
                      </label>
                    ))}
                  </div>
                  {selectedStorageIds.size > 0 && cleanupPlans.length === 0 ? (
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 bg-muted/20 px-3 py-2" data-testid="storage-selection-bar">
                      <span className="text-xs">{selectedStorageIds.size} selected · {formatBytes(selectedBytes)}</span>
                      <Button type="button" size="sm" variant="destructive" disabled={cleanupBusy} onClick={() => void prepareSubagentCleanup()}>
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                        Review cleanup…
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-md border border-border/50 p-4 text-center text-xs text-muted-foreground">This session has no stored sub-agent records.</div>
              )}
              {cleanupPlans.length > 0 ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3" data-testid="storage-cleanup-confirmation">
                  <div className="font-medium">
                    {cleanupConfirmationStep === 'review' ? 'Review selected cleanup' : 'Final confirmation required'}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {plannedSessions} sub-agent {plannedSessions === 1 ? 'session' : 'sessions'}, {plannedItems} exact filesystem {plannedItems === 1 ? 'entry' : 'entries'}, and approximately {formatBytes(plannedBytes)} will be quarantined.
                    Graph results and tombstones remain. Every plan is revalidated by the Host immediately before its files are moved.
                  </p>
                  {cleanupConfirmationStep === 'final' ? (
                    <p className="mt-2 font-medium text-destructive">
                      Confirm again. Detailed records cannot be restored from the Kala UI after cleanup.
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {cleanupConfirmationStep === 'review' ? (
                      <Button type="button" size="sm" variant="destructive" disabled={cleanupBusy} data-testid="storage-cleanup-first-confirm" onClick={() => setCleanupConfirmationStep('final')}>
                        Continue
                      </Button>
                    ) : (
                      <Button type="button" size="sm" variant="destructive" disabled={cleanupBusy} data-testid="storage-cleanup-final-confirm" onClick={() => void executeCleanup()}>
                        Confirm cleanup
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="outline" disabled={cleanupBusy} onClick={() => {
                      setCleanupPlans([])
                      setCleanupConfirmationStep('review')
                    }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
              <p className="text-caption text-muted-foreground">
                Last measured {storage.state.measuredAt ? formatTs(storage.state.measuredAt) : 'not yet'}. {storage.state.source === 'postgres' ? 'Refresh reads current PostgreSQL and object-storage accounting.' : 'Refresh performs a lazy metadata scan rather than reading complete session logs.'}
              </p>
            </>
          ) : !storageError ? (
            <p className="text-xs text-muted-foreground">{storageLoading ? 'Measuring storage…' : 'Storage has not been measured yet.'}</p>
          ) : null}
        </section>
        )}
        </DialogBody>

        <DialogFooter className="border-t border-border/60 bg-card px-4 py-3 sm:px-6" data-testid="session-metadata-footer">
          {activeTab === 'overview' ? (
            <Button type="button" onClick={save} disabled={!canSave} data-testid="session-metadata-save">
              {t('common.save')}
            </Button>
          ) : null}
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t('common.close')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReadOnlyRow({
  label,
  labelHelp,
  value,
  mono = false,
  testId,
  action,
}: {
  label: string
  labelHelp?: string
  value: string
  mono?: boolean
  testId?: string
  action?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="flex items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground">
        {label}
        {labelHelp ? <HelpHint label={label}>{labelHelp}</HelpHint> : null}
        {action}
      </span>
      <span
        data-testid={testId}
        className={
          mono
            ? 'font-mono text-xs text-foreground truncate max-w-[65%]'
            : 'text-foreground truncate max-w-[65%]'
        }
        title={value}
      >
        {value}
      </span>
    </div>
  )
}

function MetadataTab({
  active,
  children,
  testId,
  onClick,
}: {
  active: boolean
  children: React.ReactNode
  testId: string
  onClick(): void
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={testId}
      className={cn(
        'min-h-9 rounded-md px-3 text-sm font-medium transition-colors',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function StatisticsRow({
  label,
  help,
  allSessions,
  thisSession,
}: {
  label: string
  help?: string
  allSessions?: React.ReactNode
  thisSession: React.ReactNode
}): JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(7.5rem,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 border-b border-border/35 px-3 py-2 text-sm last:border-b-0" data-testid="session-statistics-row">
      <div className="flex min-w-0 items-center gap-1 text-xs font-medium text-muted-foreground">
        {label}
        {help ? <HelpHint label={label}>{help}</HelpHint> : null}
      </div>
      <div className="min-w-0 truncate font-medium" title={typeof allSessions === 'string' ? allSessions : undefined}>{allSessions ?? <span className="text-muted-foreground/60">—</span>}</div>
      <div className="min-w-0 truncate font-medium" title={typeof thisSession === 'string' ? thisSession : undefined}>{thisSession}</div>
    </div>
  )
}

function TokenPairBadges({ input, output }: { input: string; output: string }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-wrap gap-1" data-testid="session-token-pair">
      <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-sky-500/20 bg-sky-500/[0.07] px-1.5 py-0.5 text-caption">
        <span className="font-semibold text-muted-foreground">IN</span>
        <span className="truncate tabular-nums">{input}</span>
      </span>
      <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-violet-500/20 bg-violet-500/[0.07] px-1.5 py-0.5 text-caption">
        <span className="font-semibold text-muted-foreground">OUT</span>
        <span className="truncate tabular-nums">{output}</span>
      </span>
    </div>
  )
}

function FieldRow({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="grid gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-xs uppercase tracking-wider text-muted-foreground"
      >
        {label}
      </label>
      {children}
    </div>
  )
}

function formatTs(iso: string | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function StorageMetric({ label, bytes }: { label: string; bytes: number }): JSX.Element {
  return <div><div className="text-caption text-muted-foreground">{label}</div><div className="font-medium">{formatBytes(bytes)}</div></div>
}

export function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value)
  const units: ReadonlyArray<[number, string]> = [[1_000_000_000, 'B'], [1_000_000, 'M'], [1_000, 'K']]
  const unit = units.find(([threshold]) => absolute >= threshold)
  if (!unit) return value.toLocaleString()
  const compact = value / unit[0]
  return `${Number(compact.toFixed(2))} ${unit[1]}`
}

function formatElapsed(start: string | undefined, end: string | undefined): string {
  if (!start || !end) return '—'
  const duration = Date.parse(end) - Date.parse(start)
  if (!Number.isFinite(duration) || duration < 0) return '—'
  const minutes = Math.floor(duration / 60_000)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

function topLevelSelectedSessionIds(
  selected: ReadonlySet<string>,
  entries: SessionStorageSnapshot['descendants'],
): string[] {
  const byId = new Map(entries.map((entry) => [entry.sessionId, entry]))
  return [...selected].filter((sessionId) => {
    let parentId = byId.get(sessionId)?.parentSessionId
    const visited = new Set<string>()
    while (parentId && !visited.has(parentId)) {
      if (selected.has(parentId)) return false
      visited.add(parentId)
      parentId = byId.get(parentId)?.parentSessionId
    }
    return true
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = units[0]!
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]!
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`
}
