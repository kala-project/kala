import { ScrollArea } from '../../components/ui/scroll-area.js'
import { useEffect, useRef, useState } from 'react'
import { Check, CheckCircle2, Clipboard, Clock3, LoaderCircle, ShieldCheck, Terminal, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { writeTextToClipboard } from '../../lib/clipboard.js'
import type {
  CreateExecutorInstall,
  ExecutorInstallEvent,
  ExecutorInstallMode,
  ExecutorInstallPlatform,
  ExecutorPrivilegeMode,
  ExecutorInstallStatusSnapshot,
} from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  dialogMobileSheetClassName,
} from '../../components/ui/dialog.js'
import { cn } from '../../lib/utils.js'
import { staticAssetUrl } from '../../lib/static-asset-url.js'

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  host?: string
  privateCloud?: boolean
  organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
}

type InstallResponse = ExecutorInstallStatusSnapshot & { command?: string; setupCode?: string }
type ExecutorInviteResponse = { id: string; inviteToken: string }
type FormState = Pick<CreateExecutorInstall, 'platform' | 'mode' | 'privilegeMode'>

const POLL_INTERVAL_MS = 2_000
const PLATFORMS = ['linux', 'macos', 'windows'] as const satisfies readonly ExecutorInstallPlatform[]
const MODES: ExecutorInstallMode[] = ['service', 'temporary']
const PRIVILEGE_MODES: ExecutorPrivilegeMode[] = ['privileged', 'restricted']

export function ConnectWorkspaceDialog({ open, onOpenChange, host, privateCloud = false, organizationRole }: Props): JSX.Element {
  const { t } = useTranslation()
  const [form, setForm] = useState<FormState>(() => ({
    platform: detectCurrentPlatform(),
    mode: 'service',
    privilegeMode: 'privileged',
  }))
  const [expertMode, setExpertMode] = useState(false)
  const [installation, setInstallation] = useState<InstallResponse | null>(null)
  const [command, setCommand] = useState('')
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const [windowsCapability, setWindowsCapability] = useState<{ key: string; available: boolean } | null>(null)
  const [pairingCode, setPairingCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [deciding, setDeciding] = useState(false)
  const [commandTransitioning, setCommandTransitioning] = useState(false)
  const generationRef = useRef(0)
  const createdFormRef = useRef<FormState | null>(null)
  const installationIdRef = useRef<string | null>(null)
  const canCreateOrganizationInvite = !privateCloud || organizationRole === 'owner' || organizationRole === 'admin'
  const capabilityKey = `${host ?? ''}:${privateCloud}`
  const windowsAvailable = windowsCapability?.key === capabilityKey && windowsCapability.available

  useEffect(() => {
    if (!open || !canCreateOrganizationInvite) return
    const controller = new AbortController()
    void request<{ platforms?: { windows?: { available?: unknown } } }>(apiEndpoint(host, '/api/executor-install-capabilities'), { signal: controller.signal })
      .then((capabilities) => {
        if (!controller.signal.aborted) setWindowsCapability({ key: capabilityKey, available: capabilities?.platforms?.windows?.available === true })
      }).catch(() => {
        if (!controller.signal.aborted) setWindowsCapability({ key: capabilityKey, available: false })
      })
    return () => controller.abort()
  }, [canCreateOrganizationInvite, capabilityKey, host, open])

  useEffect(() => {
    if (!open) {
      generationRef.current += 1
      // Do not delete the installation when the dialog closes. The normal flow
      // is copy command → close dialog → run it in another terminal; deleting
      // here invalidated the displayed one-time setup code before it could be
      // claimed and made every copied command fail with HTTP 401. Unclaimed
      // records are bounded by the Host TTL and expire automatically.
      installationIdRef.current = null
      setInstallation(null)
      setCommand('')
      setInviteToken(null)
      setWindowsCapability(null)
      setPairingCode(null)
      setError(null)
      setCopyError(null)
      setCommandTransitioning(false)
      createdFormRef.current = null
      return
    }

    const generation = ++generationRef.current
    const controller = new AbortController()
    if (privateCloud) {
      setInstallation(null)
      setPairingCode(null)
      setCommand('')
      setInviteToken(null)
      setError(null)
      if (!canCreateOrganizationInvite) return () => controller.abort()
      void request<ExecutorInviteResponse>(apiEndpoint(host, '/auth/executor-invites'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      }).then((invite) => {
        if (generationRef.current !== generation) return
        setInviteToken(invite.inviteToken)
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted && generationRef.current === generation) setError(errorMessage(cause))
      })
      return () => controller.abort()
    }
    // Never silently create a Linux installation on a Windows browser.
    if (installationIdRef.current || (form.platform === 'windows' && !windowsAvailable)) return () => controller.abort()
    const input = toApiInput(form)
    createdFormRef.current = form
    setError(null)
    void request<InstallResponse>(apiEndpoint(host, '/api/executor-installs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    }).then((created) => {
      if (generationRef.current !== generation) return
      installationIdRef.current = created.id
      setInstallation(created)
      setCommand(created.command ?? '')
      updatePairingCode(created, setPairingCode)
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted && generationRef.current === generation) setError(errorMessage(cause))
    })

    return () => controller.abort()
    // A session is created once per opening. Form edits are handled by the debounced PATCH effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCreateOrganizationInvite, host, open, privateCloud, !privateCloud && form.platform === 'windows', !privateCloud && form.platform === 'windows' && windowsAvailable])

  useEffect(() => {
    if (!privateCloud || !open) return
    setCommand(inviteToken && (form.platform !== 'windows' || windowsAvailable)
      ? organizationInviteCommand(host, inviteToken, form.platform, form.mode, form.privilegeMode)
      : '')
    setCopied(false)
  }, [form.mode, form.platform, form.privilegeMode, host, inviteToken, open, privateCloud, windowsAvailable])

  useEffect(() => {
    if (privateCloud || !open || !installation || !createdFormRef.current || sameForm(form, createdFormRef.current)) return
    if (form.platform === 'windows' && !windowsAvailable) { setCommandTransitioning(true); return }
    const previousInstallationId = installation.id
    const generation = generationRef.current
    const controller = new AbortController()
    // A setup command contains a one-time code that the Host stores only as a
    // hash. PATCH cannot regenerate that command for a new platform or mode.
    // Create a replacement immediately, then retire the still-unclaimed old record.
    void request<InstallResponse>(apiEndpoint(host, '/api/executor-installs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toApiInput(form)),
      signal: controller.signal,
    }).then((created) => {
      if (generationRef.current !== generation) return
      installationIdRef.current = created.id
      createdFormRef.current = form
      setInstallation(created)
      setCommand(created.command ?? '')
      updatePairingCode(created, setPairingCode)
      setError(null)
      setCommandTransitioning(false)
      void fetch(apiEndpoint(host, `/api/executor-installs/${encodeURIComponent(previousInstallationId)}`), { method: 'DELETE' }).catch(() => {})
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted && generationRef.current === generation) {
        setError(errorMessage(cause))
        setCommandTransitioning(false)
      }
    })
    return () => controller.abort()
  }, [form, host, installation, open, privateCloud, windowsAvailable])

  useEffect(() => {
    if (privateCloud || !open || !installation) return
    const installationId = installation.id
    const generation = generationRef.current
    let lastSeq = installation.seq
    let stopped = false
    let timeout: number | undefined
    let controller: AbortController | undefined

    const poll = async (): Promise<void> => {
      controller = new AbortController()
      try {
        const encodedId = encodeURIComponent(installationId)
        const [snapshot, eventResult] = await Promise.all([
          request<InstallResponse>(apiEndpoint(host, `/api/executor-installs/${encodedId}`), { signal: controller.signal }),
          request<{ events: ExecutorInstallEvent[] }>(apiEndpoint(host, `/api/executor-installs/${encodedId}/events?after=${lastSeq}`), { signal: controller.signal }),
        ])
        if (stopped || generationRef.current !== generation) return
        const events = eventResult.events ?? []
        const latestEvent = events.at(-1)
        lastSeq = Math.max(lastSeq, snapshot.seq, latestEvent?.seq ?? -1)
        const next = latestEvent && latestEvent.seq > snapshot.seq
          ? { ...snapshot, status: latestEvent.status, seq: latestEvent.seq, errorCode: latestEvent.errorCode }
          : snapshot
        setInstallation(next)
        if (snapshot.command !== undefined) setCommand(snapshot.command)
        updatePairingCode(latestEvent ?? snapshot, setPairingCode)
        setError(next.errorCode ?? null)
      } catch (cause) {
        if (!controller.signal.aborted && !stopped) setError(errorMessage(cause))
      } finally {
        if (!stopped && generationRef.current === generation) timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
      }
    }

    timeout = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      stopped = true
      if (timeout !== undefined) window.clearTimeout(timeout)
      controller?.abort()
    }
  }, [host, installation?.id, open, privateCloud])

  const updateForm = (patch: Partial<FormState>): void => {
    setForm((current) => {
      const next = nextForm(current, patch)
      return next
    })
    setCopied(false)
    setCopyError(null)
    if (createdFormRef.current) setCommandTransitioning(!sameForm(nextForm(form, patch), createdFormRef.current))
  }

  const toggleExpertMode = (): void => {
    if (expertMode) updateForm({ mode: 'service', privilegeMode: 'privileged' })
    setExpertMode((current) => !current)
  }

  const copy = async (): Promise<void> => {
    if (commandTransitioning || !command || (form.platform === 'windows' && !windowsAvailable)) return
    try {
      await writeTextToClipboard(command)
      setCopyError(null)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_600)
    } catch (cause) {
      setCopied(false)
      setCopyError(errorMessage(cause))
    }
  }

  const decide = async (action: 'approve' | 'reject'): Promise<void> => {
    if (!installation) return
    setDeciding(true)
    try {
      const updated = await request<InstallResponse>(apiEndpoint(host, `/api/executor-installs/${encodeURIComponent(installation.id)}/${action}`), { method: 'POST' })
      setInstallation(updated)
      updatePairingCode(updated, setPairingCode)
      setError(null)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setDeciding(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(dialogMobileSheetClassName, 'grid min-w-0 max-w-4xl grid-rows-[auto_minmax(0,1fr)] border-0 bg-popover shadow-2xl sm:max-h-[min(var(--ak-viewport-h,92dvh),46rem)] sm:rounded-3xl')} data-testid="connect-workspace-dialog">
        <DialogHeader className="border-b border-border/35 px-5 pb-4 pt-5 pr-14 sm:px-7 sm:pb-5 sm:pt-6 sm:pr-16">
          <span className="mb-2 inline-flex items-center gap-2 text-caption font-medium uppercase tracking-[0.14em] text-muted-foreground" aria-hidden="true">
            <Terminal className="h-3.5 w-3.5" /> Workspace setup
          </span>
          <DialogTitle className="text-xl font-semibold tracking-tight sm:text-2xl">{t('explorer.connectDialog.title')}</DialogTitle>
          <DialogDescription className="max-w-2xl text-sm leading-5">{t('explorer.connectDialog.description')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 min-w-0 overflow-x-hidden" contentClassName="p-5 sm:p-7 min-w-full">
          {privateCloud ? (
            <section className="min-w-0 space-y-5" data-testid="private-cloud-executor-invite">
              <div className="rounded-2xl bg-primary/10 px-4 py-3 text-sm leading-6 text-muted-foreground">
                <div className="flex items-start gap-2"><ShieldCheck className="mt-1 h-4 w-4 flex-none text-primary" aria-hidden="true" /><p>{t('explorer.connectDialog.organizationInviteDescription')}</p></div>
              </div>
              {canCreateOrganizationInvite ? (
                <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.2fr)] lg:gap-8">
                  <section className="min-w-0 space-y-5" aria-label={t('executorPairing.installationOptions')}>
                    <SectionLabel index="1" label={t('explorer.connectDialog.platform')} />
                    <InstallationOptions form={form} expertMode={expertMode} windowsAvailable={windowsAvailable} updateForm={updateForm} toggleExpertMode={toggleExpertMode} />
                  </section>
                  <section className="min-w-0 space-y-3 lg:border-l lg:border-border/35 lg:pl-8">
                  <SectionLabel index="2" label={t('explorer.connectDialog.runCommand')} />
                  <TerminalCommand command={command} copied={copied} mode={form.mode} modeLabel={t(`explorer.connectDialog.modes.${form.mode}`)} transitioning={false} onCopy={() => void copy()} />
                  {form.mode === 'temporary' ? <p className="rounded-xl bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground">{t('explorer.connectDialog.organizationInviteTerminalHint')}</p> : null}
                  {error || copyError ? <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error ?? copyError}</p> : null}
                  </section>
                </div>
              ) : (
                <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert" data-testid="executor-invite-admin-required">{t('explorer.connectDialog.adminRequired')}</p>
              )}
            </section>
          ) : (
          <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.2fr)] lg:gap-8">
            <section className="min-w-0 space-y-5" aria-label={t('executorPairing.installationOptions')}>
              <SectionLabel index="1" label={t('explorer.connectDialog.platform')} />
              <InstallationOptions form={form} expertMode={expertMode} windowsAvailable={windowsAvailable} updateForm={updateForm} toggleExpertMode={toggleExpertMode} />
            </section>
            <section className="min-w-0 space-y-3 lg:border-l lg:border-border/35 lg:pl-8">
              <div className="flex items-center justify-between gap-3">
                <SectionLabel index="2" label={t('explorer.connectDialog.runCommand')} />
                <InstallStatus status={installation?.status ?? 'preparing'} label={t(`explorer.connectDialog.statuses.${installation?.status ?? 'preparing'}`)} />
              </div>
              <TerminalCommand
                key={`${form.platform}:${form.mode}`}
                command={command}
                copied={copied}
                mode={form.mode}
                modeLabel={t(`explorer.connectDialog.modes.${form.mode}`)}
                transitioning={commandTransitioning}
                onCopy={() => void copy()}
              />
              {pairingCode ? (
                <div className="flex min-w-0 flex-col gap-3 rounded-2xl bg-amber-500/10 p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="connect-workspace-pairing">
                  <span className="flex min-w-0 items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4 flex-none text-amber-600 dark:text-amber-300" /><span className="text-muted-foreground">{t('explorer.connectDialog.installationStatus')}</span><strong className="font-mono tracking-widest text-foreground">{pairingCode}</strong></span>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={deciding} onClick={() => void decide('approve')}>{t('explorer.connectDialog.approve')}</Button>
                    <Button size="sm" variant="ghost" disabled={deciding} onClick={() => void decide('reject')}>{t('explorer.connectDialog.reject')}</Button>
                  </div>
                </div>
              ) : null}
              {error || copyError ? <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error ?? copyError}</p> : null}
            </section>
          </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function InstallationOptions({ form, expertMode, windowsAvailable, updateForm, toggleExpertMode }: { form: FormState; expertMode: boolean; windowsAvailable: boolean; updateForm(patch: Partial<FormState>): void; toggleExpertMode(): void }): JSX.Element {
  const { t } = useTranslation()
  return <>
    <PlatformGroup label={t('explorer.connectDialog.platform')} selected={form.platform} windowsAvailable={windowsAvailable} labelFor={(value) => t(`explorer.connectDialog.platforms.${value}`)} onChange={(platform) => updateForm({ platform })} />
    <button type="button" role="switch" aria-checked={expertMode} data-testid="connect-workspace-expert-mode" onClick={toggleExpertMode} className="flex w-full items-center justify-between gap-4 rounded-xl bg-muted/25 px-3 py-2.5 text-left transition-colors hover:bg-muted/45">
      <span className="min-w-0"><span className="block text-xs font-medium text-foreground">{t('explorer.connectDialog.expertMode')}</span><span className="mt-0.5 block text-caption leading-4 text-muted-foreground">{t('explorer.connectDialog.expertModeDescription')}</span></span>
      <span className={cn('relative h-5 w-9 flex-none rounded-full transition-colors', expertMode ? 'bg-primary' : 'bg-muted-foreground/25')} aria-hidden="true"><span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-background shadow-sm transition-transform', expertMode ? 'translate-x-[1.125rem]' : 'translate-x-0.5')} /></span>
    </button>
    {expertMode ? <div className="space-y-4" data-testid="connect-workspace-expert-options">
      <ChoiceGroup label={t('explorer.connectDialog.runMode')} values={MODES} selected={form.mode} recommended="service" labelFor={(value) => t(`explorer.connectDialog.modes.${value}`)} onChange={(mode) => updateForm({ mode })} />
      <p className="rounded-xl bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground" data-testid="connect-workspace-mode-description">{t(`explorer.connectDialog.modeDescriptions.${form.mode}`)}</p>
      {form.mode === 'service' ? <>
        <ChoiceGroup label={t('explorer.connectDialog.privilegeMode')} values={PRIVILEGE_MODES} selected={form.privilegeMode} recommended="privileged" disabledFor={(value) => value === 'restricted' && form.platform !== 'linux'} labelFor={(value) => t(`explorer.connectDialog.privilegeModes.${value}`)} onChange={(privilegeMode) => updateForm({ privilegeMode })} />
        <p className="rounded-xl bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground" data-testid="connect-workspace-privilege-description">{t(`explorer.connectDialog.privilegeModeDescriptions.${form.privilegeMode}`)}{form.platform !== 'linux' ? ` ${t('explorer.connectDialog.restrictedLinuxOnly')}` : ''}</p>
      </> : null}
    </div> : null}
  </>
}

function SectionLabel({ index, label }: { index: string; label: string }): JSX.Element {
  return <h3 className="flex items-center gap-2 text-sm font-medium text-foreground"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 font-mono text-caption text-primary">{index}</span>{label}</h3>
}

function PlatformGroup({ label, selected, windowsAvailable, labelFor, onChange }: { label: string; selected: ExecutorInstallPlatform; windowsAvailable: boolean; labelFor(value: ExecutorInstallPlatform): string; onChange(value: ExecutorInstallPlatform): void }): JSX.Element {
  const { t } = useTranslation()
  const icons = {
    linux: <img src={staticAssetUrl('/icons/linux.svg')} alt="" className="h-7 w-7 object-contain" aria-hidden="true" />,
    macos: <img src={staticAssetUrl('/icons/macos.svg')} alt="" className="h-7 w-7 object-contain" aria-hidden="true" />,
    windows: <img src={staticAssetUrl('/icons/windows.svg')} alt="" className="h-7 w-7 object-contain" aria-hidden="true" />,
  }
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{label}</legend>
      <div className="grid grid-cols-3 gap-2">{PLATFORMS.map((value) => (
        <button key={value} type="button" disabled={value === 'windows' && !windowsAvailable} aria-pressed={selected === value} data-testid={`connect-workspace-${value}`} onClick={() => onChange(value)} className={`flex min-h-16 min-w-0 flex-col items-center justify-center gap-1.5 rounded-2xl px-2 text-xs font-medium transition-[background-color,color,box-shadow,transform] active:scale-[0.98] ${selected === value ? 'bg-accent text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]' : 'bg-muted/20 text-muted-foreground hover:bg-accent/55 hover:text-foreground'} ${value === 'windows' && !windowsAvailable ? 'cursor-not-allowed opacity-60' : ''}`}>
          {icons[value]}<span className="text-center">{labelFor(value)}</span>
          {value === 'windows' && !windowsAvailable ? <span className="text-center text-caption">{t('explorer.connectDialog.windowsUnavailableShort')}</span> : null}
        </button>
      ))}</div>
      {!windowsAvailable ? <p className="mt-2 text-xs text-muted-foreground" data-testid="connect-workspace-windows-notice">{t('explorer.connectDialog.windowsUnavailable')}</p> : null}
    </fieldset>
  )
}

function ChoiceGroup<T extends string>({ label, values, selected, recommended, disabledFor, labelFor, onChange }: { label: string; values: readonly T[]; selected: T; recommended?: T; disabledFor?(value: T): boolean; labelFor(value: T): string; onChange(value: T): void }): JSX.Element {
  const { t } = useTranslation()
  return <fieldset className="min-w-0 space-y-2.5"><legend className="text-xs font-medium text-muted-foreground">{label}</legend><div className="grid min-w-0 grid-cols-2 rounded-xl bg-muted/30 p-1">{values.map((value) => <button key={value} type="button" disabled={disabledFor?.(value)} aria-pressed={selected === value} data-testid={`connect-workspace-${value}`} onClick={() => onChange(value)} className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-center text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${selected === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}><span className="min-w-0 break-words">{labelFor(value)}</span>{value === recommended ? <span className="max-w-full rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-caption font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300">{t('dialogs.runtime.recommended')}</span> : null}</button>)}</div></fieldset>
}

function TerminalCommand({ command, copied, mode, modeLabel, transitioning, onCopy }: { command: string; copied: boolean; mode: ExecutorInstallMode; modeLabel: string; transitioning: boolean; onCopy(): void }): JSX.Element {
  const { t } = useTranslation()
  if (command.includes('\n') || command.includes('\r')) throw new Error('Executor install command must be one physical line')
  return (
    <section
      className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-border/60 bg-muted/35 text-foreground shadow-sm"
      data-testid="executor-terminal-command"
      data-mode={mode}
      aria-busy={transitioning}
    >
      <div className="flex items-center justify-between border-b border-border/50 bg-background/45 px-4 py-2">
        <span className="text-caption font-medium uppercase tracking-[0.12em] text-muted-foreground">{modeLabel}</span>
        {transitioning ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-primary" data-testid="executor-command-transition" aria-hidden="true" /> : null}
      </div>
      <div className={cn('flex min-w-0 flex-col gap-3 p-4 transition-opacity duration-200 sm:flex-row sm:items-start', transitioning && 'animate-pulse opacity-55')}>
        <span className="flex min-w-0 flex-1 items-start gap-3"><Terminal className="mt-0.5 h-4 w-4 flex-none text-primary" aria-hidden="true" /><pre className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[0.75rem] leading-5">{command || t('explorer.connectDialog.preparing')}</pre></span>
        <Button type="button" variant="outline" size="sm" className="h-9 w-full flex-none gap-1.5 rounded-lg bg-background/70 px-3 text-caption shadow-none hover:bg-accent sm:w-auto" onClick={onCopy} disabled={!command || transitioning} data-testid="copy-executor-command">{copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}{copied ? t('common.copied') : t('common.copy')}</Button>
      </div>
    </section>
  )
}

function InstallStatus({ status, label }: { status: string; label: string }): JSX.Element {
  const completed = status === 'paired' || status === 'connected' || status === 'completed'
  const failed = status === 'failed' || status === 'rejected' || status === 'expired'
  const waiting = status === 'pairing_pending' || status === 'approval_pending'
  const Icon = completed ? CheckCircle2 : failed ? XCircle : waiting ? Clock3 : LoaderCircle
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 text-xs ${completed ? 'text-emerald-600 dark:text-emerald-300' : failed ? 'text-destructive' : waiting ? 'text-amber-600 dark:text-amber-300' : 'text-muted-foreground'}`}
      data-testid="installation-status"
      aria-live="polite"
    >
      <Icon className={`h-3.5 w-3.5 flex-none ${!completed && !failed && !waiting ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  )
}

function toApiInput(form: FormState): CreateExecutorInstall {
  return { platform: form.platform, mode: form.mode, privilegeMode: form.privilegeMode, workspaceRoot: '__KALA_CURRENT_DIRECTORY__' }
}

function sameForm(left: FormState, right: FormState): boolean {
  return JSON.stringify(toApiInput(left)) === JSON.stringify(toApiInput(right))
}

function nextForm(current: FormState, patch: Partial<FormState>): FormState {
  const next = { ...current, ...patch }
  return next.platform === 'linux' ? next : { ...next, privilegeMode: 'privileged' }
}

function updatePairingCode(value: ExecutorInstallEvent | ExecutorInstallStatusSnapshot, set: (code: string | null) => void): void {
  if (value.status !== 'pairing_pending') { set(null); return }
  const metadata = 'metadata' in value ? value.metadata : undefined
  const code = metadata?.pairingCode ?? metadata?.code
  set(typeof code === 'string' || typeof code === 'number' ? String(code) : null)
}

function apiEndpoint(host: string | undefined, path: string): string {
  return host ? new URL(path, host).toString() : path
}

function organizationInviteCommand(host: string | undefined, inviteToken: string, platform: ExecutorInstallPlatform, mode: ExecutorInstallMode, privilegeMode: ExecutorPrivilegeMode): string {
  const origin = host ? new URL(host).origin : window.location.origin
  if (platform === 'windows') return `$env:EXECUTOR_INVITE=${quotePs(inviteToken)}; $env:KALA_INVITE_INSTALL_MODE=${quotePs(mode)}; irm ${quotePs(`${origin}/install/invite.ps1`)} | iex`
  const options = [
    `EXECUTOR_INVITE=${quoteSh(inviteToken)}`,
    ...(mode === 'temporary' ? ["KALA_INVITE_INSTALL_MODE='temporary'"] : []),
    ...(mode === 'service' && privilegeMode === 'restricted' ? ["KALA_INVITE_PRIVILEGE_MODE='restricted'"] : []),
  ].join(' ')
  return `(set -o pipefail; curl -fsSL ${quoteSh(`${origin}/install/invite.sh`)} | ${options} bash)`
}

function quoteSh(value: string): string { return `'${value.replace(/'/gu, `'"'"'`)}'` }
function quotePs(value: string): string { return `'${value.replace(/'/gu, "''")}'` }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(await response.text())
  return await response.json() as T
}

function errorMessage(value: unknown): string { return value instanceof Error ? value.message : String(value) }

function detectCurrentPlatform(): ExecutorInstallPlatform {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = (nav.userAgentData?.platform ?? navigator.platform ?? '').toLowerCase()
  if (platform.includes('win')) return 'windows'
  if (platform.includes('mac')) return 'macos'
  return 'linux'
}
