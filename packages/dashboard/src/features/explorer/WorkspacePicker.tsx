import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HelpHint } from '../../components/ui/help-hint.js'
import type { AgentRuntimeDescriptor, AgentRuntimeId, AttachedExecutor, SessionExecutionMode } from '@agent-kernel/shared'
import { KERNEL_AGENT_RUNTIME_CAPABILITIES } from '@agent-kernel/shared'

import { Bot, Check, Clipboard, Info, X } from 'lucide-react'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  dialogMobileSheetClassName,
  dialogTouchCloseClassName,
} from '../../components/ui/dialog.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import { writeTextToClipboard } from '../../lib/clipboard.js'
import { cn } from '../../lib/utils.js'
import { PREF_AGENT_RUNTIME, readStringPref, writeStringPref } from '../../lib/prefs.js'
import type { DashboardSocket } from '../../session.js'
import { isRecommendedRuntime, runtimeDisplayDescription, runtimeDisplayLabel } from '../../app-logic/agent-runtime-display.js'
import { DirectoryPicker } from './DirectoryPicker.js'

type Props = {
  open: boolean
  workspaces: readonly AttachedExecutor[]
  agentRuntimes?: readonly AgentRuntimeDescriptor[]
  initialWorkspaceId?: string
  socket: DashboardSocket | null
  error?: string | null
  submitting?: boolean
  onCreate(input: {
    agentRuntime: AgentRuntimeId
    executionMode: SessionExecutionMode
    workspaceId: string
    workspaceName: string | undefined
    cwd: string
  }): void
  onCreateSimpleChat(agentRuntime: AgentRuntimeId): void
  onCancel(): void
}

// Run in the Host installation directory, not in the browser or Workspace Executor.
const COPILOT_SDK_INSTALL_COMMAND = 'npm install --include=optional @github/copilot-sdk@1.0.14'

export function NewSessionDialog({
  open,
  workspaces,
  agentRuntimes = [{
    id: 'kernel',
    label: 'Kala',
    description: 'Agent Kernel',
    available: true,
    status: 'ready',
    capabilities: KERNEL_AGENT_RUNTIME_CAPABILITIES,
  }],
  initialWorkspaceId,
  socket,
  error,
  submitting = false,
  onCreate,
  onCreateSimpleChat,
  onCancel,
}: Props): JSX.Element {
  const { t } = useTranslation()
  const [workspaceId, setWorkspaceId] = useState('')
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntimeId>('kernel')
  const [executionMode, setExecutionMode] = useState<SessionExecutionMode>('chat')
  const [cwd, setCwd] = useState('')
  const [missingWorkspaceId, setMissingWorkspaceId] = useState<string | null>(null)
  const [copilotInstallCopied, setCopilotInstallCopied] = useState(false)
  const [copilotCopyFailed, setCopilotCopyFailed] = useState(false)
  const initializedOpenRef = useRef(false)
  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.workspaceId === workspaceId),
    [workspaceId, workspaces],
  )

  useEffect(() => {
    if (!open) {
      initializedOpenRef.current = false
      return
    }
    if (initializedOpenRef.current) return
    initializedOpenRef.current = true
    setExecutionMode('chat')
    const rememberedRuntime = readStringPref(PREF_AGENT_RUNTIME, 'kernel')
    const preferredRuntime = agentRuntimes.find((runtime) => runtime.id === rememberedRuntime && runtime.available)
      ?? agentRuntimes.find((runtime) => runtime.id === 'kernel' && runtime.available)
      ?? agentRuntimes.find((runtime) => runtime.available)
    setAgentRuntime(preferredRuntime?.id ?? 'kernel')
    if (initialWorkspaceId) {
      const initial = workspaces.find((w) => w.workspaceId === initialWorkspaceId)
      setWorkspaceId(initialWorkspaceId)
      setCwd(initial ? initialPathFor(initial) : '')
      return
    }
    const first = workspaces[0]
    setWorkspaceId(first?.workspaceId ?? '')
    setCwd(first ? initialPathFor(first) : '')
  }, [agentRuntimes, initialWorkspaceId, open, workspaces])

  useEffect(() => {
    if (!open) return
    if (!workspaceId) {
      setMissingWorkspaceId(null)
      return
    }
    const workspace = workspaces.find((w) => w.workspaceId === workspaceId)
    setMissingWorkspaceId(workspace ? null : workspaceId)
    if (!workspace) setCwd('')
    else setCwd((prev) => (prev.trim().length === 0 ? initialPathFor(workspace) : prev))
  }, [open, workspaceId, workspaces])

  const selectWorkspace = (id: string): void => {
    const workspace = workspaces.find((w) => w.workspaceId === id)
    setWorkspaceId(id)
    setMissingWorkspaceId(workspace ? null : id)
    setCwd(workspace ? initialPathFor(workspace) : '')
  }

  const selectAgentRuntime = (runtime: AgentRuntimeId): void => {
    setAgentRuntime(runtime)
    writeStringPref(PREF_AGENT_RUNTIME, runtime)
  }

  const create = (): void => {
    if (submitting || !selectedWorkspace || cwd.trim().length === 0) return
    onCreate({
      agentRuntime,
      executionMode,
      workspaceId: selectedWorkspace.workspaceId,
      workspaceName: selectedWorkspace.workspaceName,
      cwd: cwd.trim(),
    })
  }

  const initialPath = selectedWorkspace ? initialPathFor(selectedWorkspace) : undefined
  const scopedWorkspace = initialWorkspaceId !== undefined && selectedWorkspace !== undefined

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onCancel() }}>
      <DialogContent className={cn(dialogMobileSheetClassName, 'h-[min(calc(var(--ak-viewport-h,100dvh)-env(safe-area-inset-top)-0.5rem),44rem)] min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden p-0 sm:max-w-4xl', error ? 'grid-rows-[auto_auto_minmax(0,1fr)_auto_auto]' : 'grid-rows-[auto_auto_minmax(0,1fr)_auto]')} data-testid="new-session-dialog">
        <DialogHeader className="relative border-b border-border/50 px-4 py-2 pr-14 sm:py-3">
          <DialogTitle className="flex items-center gap-1">{t('dialogs.newSession')}<HelpHint label={t('dialogs.newSession')}><span className="block">{t('dialogs.newSessionDescription')}</span><span className="mt-2 block"><strong>{t('dialogs.simpleChat')}</strong><br />{t('dialogs.simpleChatDescription')}</span></HelpHint></DialogTitle>
          <DialogDescription className="sr-only">{t('common.contextualHelp')}</DialogDescription>
          <DialogClose className={dialogTouchCloseClassName} disabled={submitting} aria-label={t('common.close')} data-testid="new-session-close">
            <X className="h-4 w-4" aria-hidden="true" />
          </DialogClose>
        </DialogHeader>
        <section className="grid min-h-0 min-w-0 max-h-[min(40vh,14rem)] grid-cols-1 gap-3 overflow-y-auto overscroll-contain border-b border-border/50 bg-muted/20 px-3 py-2 sm:grid-cols-2" data-testid="new-session-options">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-1">
              <span id="new-session-runtime-label" className="text-caption font-semibold text-muted-foreground">
                {t('dialogs.chooseAgentRuntime')}
              </span>
              <HelpHint label={t('dialogs.chooseAgentRuntime')} trigger={<span className="inline-flex h-6 w-6 flex-none items-center justify-center rounded text-muted-foreground/70 hover:text-foreground" aria-label={t('dialogs.chooseAgentRuntime')}><Info className="h-3.5 w-3.5" aria-hidden="true" /></span>}>{agentRuntimes.map((runtime) => <span className="mb-2 block last:mb-0" key={runtime.id}><strong>{runtimeDisplayLabel(t, runtime)}</strong><br />{runtimeDisplayDescription(t, runtime)}</span>)}</HelpHint>
            </div>
            <div className="grid min-w-0 grid-cols-2 gap-1 rounded-md border border-border bg-card p-0.5" role="radiogroup" aria-labelledby="new-session-runtime-label">
              {agentRuntimes.map((runtime) => {
                const selected = agentRuntime === runtime.id
                const label = runtimeDisplayLabel(t, runtime)
                const description = runtimeDisplayDescription(t, runtime)
                const button = (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={submitting || !runtime.available}
                    onClick={() => selectAgentRuntime(runtime.id)}
                    data-testid={`new-session-runtime-${runtime.id}`}
                    title={runtime.available ? description : undefined}
                    className={cn(
                      'flex min-h-11 min-w-0 items-center justify-center gap-1 rounded px-1.5 py-1 text-center text-sm font-medium leading-tight transition-colors',
                      selected ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      !runtime.available && 'cursor-not-allowed opacity-55',
                    )}
                  >
                    {runtime.id === 'copilot' ? <GitHubMark className="h-3 w-3 flex-none" /> : <Bot className="h-3 w-3 flex-none" aria-hidden="true" />}
                    <span className="min-w-0 break-words">{label}</span>
                    {isRecommendedRuntime(runtime) ? <span className="sr-only">{t('dialogs.runtime.recommended')}</span> : null}
                  </button>
                )
                if (runtime.available) return <span key={runtime.id} className="min-w-0">{button}</span>
                const needsSdk = runtime.id === 'copilot' && runtime.status === 'unavailable'
                  && /^Copilot (?:SDK|CLI) unavailable:/u.test(runtime.reason ?? '')
                return (
                  <HelpHint key={runtime.id} label={label} trigger={
                    <span role="group" tabIndex={0} aria-label={`${label}: ${runtime.reason ?? t('dialogs.runtime.unavailable')}`}
                      className="min-w-0 cursor-help [&>button]:pointer-events-none">{button}</span>
                  }>
                    <span className="block">{runtime.reason ?? t('dialogs.runtime.unavailable')}</span>
                    {needsSdk ? <span className="mt-2 block">
                      <span className="block">{t('dialogs.runtime.githubCopilot.installOnHost')}</span>
                      <code className="my-2 block select-all rounded bg-muted p-2 font-mono text-xs">{COPILOT_SDK_INSTALL_COMMAND}</code>
                      <Button type="button" size="sm" variant="outline" data-testid="copy-copilot-install"
                        onClick={() => {
                          void writeTextToClipboard(COPILOT_SDK_INSTALL_COMMAND).then(() => {
                            setCopilotInstallCopied(true)
                            setCopilotCopyFailed(false)
                          }).catch(() => { setCopilotInstallCopied(false); setCopilotCopyFailed(true) })
                        }}>
                        {copilotInstallCopied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Clipboard className="mr-1 h-3.5 w-3.5" />}
                        {copilotInstallCopied ? t('common.copied') : t('common.copy')}
                      </Button>
                      {copilotCopyFailed ? <span role="alert" className="ml-2 text-destructive">{t('common.copyFailed')}</span> : null}
                      <span className="mt-2 block">{t('dialogs.runtime.githubCopilot.restartHost')}</span>
                    </span> : null}
                  </HelpHint>
                )
              })}
            </div>
            {agentRuntimes.filter((runtime) => !runtime.available).map((runtime) => (
              <p key={runtime.id} className="text-xs text-muted-foreground" data-testid={`new-session-runtime-reason-${runtime.id}`}>
                {runtimeDisplayLabel(t, runtime)}: {runtime.reason ?? t('dialogs.runtime.unavailable')}
              </p>
            ))}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-1">
              <span id="new-session-mode-label" className="text-caption font-semibold text-muted-foreground">
                {t('dialogs.chooseExecutionMode')}
              </span>
              <HelpHint label={t('dialogs.chooseExecutionMode')}>{(['chat', 'dag'] as const).map((mode) => <span className="mb-2 block last:mb-0" key={mode}><strong>{t(`dialogs.executionMode.${mode}.label`)}</strong><br />{t(`dialogs.executionMode.${mode}.description`)}</span>)}</HelpHint>
            </div>
            <div className="grid min-w-0 grid-cols-2 gap-1 rounded-md border border-border bg-card p-0.5" role="radiogroup" aria-labelledby="new-session-mode-label">
              {(['chat', 'dag'] as const).map((mode) => {
                const selected = executionMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={submitting}
                    onClick={() => setExecutionMode(mode)}
                    data-testid={`new-session-mode-${mode}`}
                    title={t(`dialogs.executionMode.${mode}.description`)}
                    className={cn(
                      'flex min-h-[3.25rem] min-w-0 flex-col items-center justify-center break-words rounded px-1.5 py-1 text-center text-sm font-medium leading-tight transition-colors',
                      selected ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <span>{t(`dialogs.executionMode.${mode}.label`)}</span>
                    <span className="text-[11px] font-normal opacity-80">{t(`dialogs.executionMode.${mode}.shortDescription`)}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </section>
        <div className={cn(
          'grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] overflow-hidden',
          scopedWorkspace
            ? 'grid-rows-1'
            : 'grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[220px_minmax(0,1fr)] md:grid-rows-1',
        )}>
          {!scopedWorkspace ? <aside data-testid="new-session-workspace-list" className="flex min-h-0 min-w-0 flex-col overflow-hidden border-b border-border/50 bg-muted/60 md:border-b-0 md:border-r md:bg-muted">
            <div className="px-2 pt-2 max-md:hidden">
              <button
                type="button"
                data-testid="new-session-simple-chat"
                disabled={submitting}
                onClick={() => onCreateSimpleChat(agentRuntime)}
                className="w-full rounded-md border border-dashed border-primary/50 bg-primary/5 px-2 py-2 text-left transition-colors hover:bg-primary/10 disabled:opacity-50"
              >
                <div className="truncate text-sm font-medium text-foreground">
                  {t('dialogs.simpleChat')}
                </div>
              </button>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground"><span>{t('dialogs.workspaceSessions')}</span><button type="button" data-testid="new-session-simple-chat-mobile" disabled={submitting} onClick={() => onCreateSimpleChat(agentRuntime)} className="ml-auto rounded px-2 py-1 text-primary hover:bg-primary/10 md:hidden">{t('dialogs.simpleChat')}</button></div>
            <ScrollArea className="min-h-0 flex-1 max-md:max-h-24">
              <div className="flex gap-2 px-2 pb-2 md:block md:space-y-1">
                {workspaces.length === 0 ? (
                  <div className="rounded border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                    {t('dialogs.noExecutorOnline')}
                  </div>
                ) : null}
                {missingWorkspaceId ? (
                  <div
                    className="rounded border border-amber-300/70 bg-amber-50 px-3 py-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
                    data-testid="new-session-missing-workspace"
                  >
                    {t('dialogs.selectedWorkspaceOffline')}
                  </div>
                ) : null}
                {workspaces.map((w) => (
                  <button
                    key={w.workspaceId}
                    type="button"
                    data-testid={`workspace-pick-${w.workspaceId}`}
                    onClick={() => selectWorkspace(w.workspaceId)}
                    className={cn(
                      'min-w-[13rem] flex-1 rounded-md border px-2 py-2 text-left transition-colors md:w-full md:min-w-0',
                      workspaceId === w.workspaceId
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border/60 bg-card hover:bg-secondary',
                    )}
                  >
                    <div className="flex min-w-0 items-baseline gap-2 font-mono">
                      <span className="min-w-0 truncate text-sm text-foreground">{w.workspaceName}</span>
                      <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{workspaceMeta(w)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </aside> : null}
          <main className="flex min-h-0 min-w-0 overflow-hidden flex-col">
            {scopedWorkspace && selectedWorkspace ? (
              <div className="flex items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-2" data-testid="new-session-scoped-workspace">
                <div className="flex min-w-0 flex-1 items-baseline gap-2 font-mono">
                  <span className="min-w-0 truncate text-sm font-medium">{selectedWorkspace.workspaceName}</span>
                  <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{workspaceMeta(selectedWorkspace)}</span>
                </div>
              </div>
            ) : null}
            <label
              className="border-b border-border/50 px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground"
              htmlFor="new-session-cwd"
            >
              {t('dialogs.newSessionInitialDirectory')}
            </label>
            <DirectoryPicker
              socket={socket}
              workspaceId={workspaceId}
              initialPath={initialPath}
              value={cwd}
              onChange={setCwd}
              inputId="new-session-cwd"
              inputTestId="new-session-cwd-input"
            />
          </main>
        </div>
        {error ? (
          <div
            className="border-t border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
            data-testid="new-session-error"
          >
            {error}
          </div>
        ) : null}
        <DialogFooter className="min-h-0 overflow-y-auto border-t border-border/50 px-3 py-2 sm:px-4 sm:py-3">
          <Button variant="outline" className="min-h-11" onClick={onCancel} disabled={submitting} data-testid="workspace-picker-cancel">
            {t('common.cancel')}
          </Button>
          <Button
            className="min-h-11"
            onClick={create}
            disabled={submitting || !selectedWorkspace || cwd.trim().length === 0}
            data-testid="new-session-create"
          >
            {submitting ? t('dialogs.newSessionCreating') : t('dialogs.newWorkspaceSessionCreate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const WorkspacePicker = NewSessionDialog

function GitHubMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 .7A11.3 11.3 0 0 0 8.4 22.8c.6.1.8-.3.8-.6v-2.2c-3.4.7-4.1-1.4-4.1-1.4-.5-1.4-1.4-1.8-1.4-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.9 1.3 1.9 1.3 1.1 1.9 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.6-1.4-5.6-6a4.7 4.7 0 0 1 1.3-3.3 4.4 4.4 0 0 1 .1-3.3s1-.3 3.4 1.3a11.7 11.7 0 0 1 6.2 0C17.9 3.8 19 4.1 19 4.1a4.4 4.4 0 0 1 .1 3.3 4.7 4.7 0 0 1 1.3 3.3c0 4.7-2.9 5.7-5.6 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.3 11.3 0 0 0 12 .7Z" />
    </svg>
  )
}

function initialPathFor(workspace: AttachedExecutor): string {
  return workspace.sandboxRoots?.[0] ?? workspace.defaultCwd ?? workspace.workingDir ?? '/'
}

function workspaceMeta(workspace: AttachedExecutor): string {
  return [workspace.os, workspace.runtime, workspace.runtimeVersion]
    .filter((s) => typeof s === 'string' && s.length > 0)
    .join(' · ')
}
