import { type ReactElement, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Clipboard, Download, Terminal, X } from 'lucide-react'
import { Button } from '../components/ui/button.js'
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger, dialogMobileSheetClassName, dialogTouchCloseClassName } from '../components/ui/dialog.js'
import { HelpHint } from '../components/ui/help-hint.js'
import { desktopDownloadBase, loadDesktopApt, loadDesktopDownload } from '../lib/desktop-download.js'
import { writeTextToClipboard } from '../lib/clipboard.js'
import { cn } from '../lib/utils.js'

function Commands({ commands, label, testId, help }: { commands: string; label: string; testId: string; help?: string }): JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <section aria-label={label} className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-border/60 bg-muted/35 text-foreground shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 bg-background/45 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1"><h3 className="text-xs font-medium">{label}</h3><HelpHint label={label}>{help ?? t('desktopDownload.commandHelp')}</HelpHint></div>
        <Button type="button" variant="outline" size="sm" className="h-9 flex-none gap-1.5 rounded-lg bg-background/70 px-3 text-caption shadow-none hover:bg-accent" data-testid={testId} aria-label={t('desktopDownload.copyLabel', { label })} onClick={async () => {
        try {
          await writeTextToClipboard(commands)
          setCopied(true)
          setFailed(false)
        } catch {
          setCopied(false)
          setFailed(true)
        }
        }}>{copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}{t(copied ? 'common.copied' : 'common.copy')}</Button>
      </div>
      {failed ? <p role="alert" className="px-3 pt-3 text-sm text-destructive">{t('desktopDownload.copyFailed')}</p> : null}
      <div className="flex min-w-0 items-start gap-2 p-3">
        <Terminal className="mt-0.5 h-4 w-4 flex-none text-primary" aria-hidden="true" />
        <pre tabIndex={0} className={cn('max-h-[min(calc(var(--ak-viewport-h,100dvh)*0.4),24rem)] min-w-0 flex-1 overflow-auto font-mono text-meta leading-5 select-text', commands.includes('\n') ? 'whitespace-pre-wrap break-all' : 'whitespace-nowrap')}>{commands}</pre>
      </div>
    </section>
  )
}

function DownloadContent({ update }: { update: boolean }): JSX.Element {
  const { t } = useTranslation()
  const [download, setDownload] = useState<Awaited<ReturnType<typeof loadDesktopDownload>>>()
  const [error, setError] = useState<string | null>(null)
  const [apt, setApt] = useState<string | null>()
  const [aptError, setAptError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void loadDesktopDownload().then((value) => { if (active) setDownload(value) })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '') })
    void loadDesktopApt().then((value) => { if (active) setApt(value) })
      .catch((reason: unknown) => { if (active) setAptError(reason instanceof Error ? reason.message : '') })
    return () => { active = false }
  }, [])
  const release = download?.release
  return (
    <DialogBody className="min-w-0" contentClassName="space-y-4 px-4 py-4 sm:px-6" data-testid="desktop-download-body">
      {release ? (
        <details role="note" data-testid="desktop-release-security" className="rounded-lg bg-amber-500/10 p-3 text-xs leading-5 ring-1 ring-inset ring-amber-500/40">
          <summary className="cursor-pointer font-semibold">{t('desktopDownload.unsigned')}</summary>
          <p className="mt-2 text-muted-foreground">{t('desktopDownload.security')} <code className="break-all">docs/operations/linux-desktop-supply-chain.md</code></p>
        </details>
      ) : null}
      {release && update ? <p role="note" data-testid="desktop-update-restart" className="rounded-lg border border-border/50 bg-muted/50 p-3 text-xs leading-5">{t('desktopUpdate.restartAfterInstall')}</p> : null}
      {error !== null ? (
        <div role="status" className="rounded-xl bg-muted/25 p-4 text-sm ring-1 ring-inset ring-border/60">
          <strong className="font-medium">{t('desktopDownload.releaseError')}</strong>
          {error ? <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">{t('desktopDownload.errorDetails')}</summary><p className="mt-1 break-words">{error}</p></details> : null}
        </div>
      ) : !release ? <p role="status" className="text-sm">{t('desktopDownload.loading')}</p> : null}
      {release ? <section className="space-y-3" aria-label={t('desktopDownload.downloadSection')}>
        {release ? <p className="text-sm">{t('desktopDownload.version', { version: release.version, size: (release.artifact.size / 1048576).toFixed(1) })}</p> : null}
        {download ? <Commands commands={download.commands} label={t('desktopDownload.command')} testId="copy-desktop-command" /> : null}
        {release ? (
          <>
            <Button asChild className="w-full sm:w-auto"><a data-testid="desktop-download-deb" href={`${desktopDownloadBase}${release.artifact.file}`} download><Download className="mr-2 h-4 w-4" />{t('desktopDownload.deb')}</a></Button>
            <p className="text-xs text-muted-foreground" data-testid="desktop-local-install-help">{t('desktopDownload.localHelp')}</p>
            {download ? <details data-testid="desktop-local-install" className="min-w-0 space-y-2">
              <summary className="cursor-pointer text-sm font-medium">{t('desktopDownload.localCommand')}</summary>
              <Commands commands={download.localCommands} label={t('desktopDownload.localCommand')} help={t('desktopDownload.localHelp')} testId="copy-desktop-local-command" />
            </details> : null}
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm underline">
              <a href={`${desktopDownloadBase}${release.dependencies.file}`} download>{t('desktopDownload.manifest')}</a>
              <a href={`${desktopDownloadBase}${release.checksums.file}`} download>SHA256SUMS.txt</a>
            </div>
            <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">{t('desktopDownload.checksum')}</summary><code className="mt-2 block break-all select-text">{release.artifact.sha256}</code></details>
          </>
        ) : null}
        <p className="text-xs text-muted-foreground">{t('desktopDownload.integrity')}</p>
        <span className="text-xs text-muted-foreground">{t('desktopDownload.remove')} <HelpHint label={t('desktopDownload.remove')}>{t('desktopDownload.removeHelp')}</HelpHint></span>
      </section> : null}
      <section className="space-y-2" aria-label={t('desktopDownload.aptSection')}>
        <div className="flex items-center gap-1">
          <h3 className="text-sm font-semibold">{t('desktopDownload.aptTitle')}</h3>
          <HelpHint label={t('desktopDownload.aptHelpLabel')}>{t('desktopDownload.aptHelp')}</HelpHint>
        </div>
        {aptError !== null ? <p role="alert" className="text-sm text-destructive">{t('desktopDownload.aptError', { detail: aptError })}</p> : apt === undefined ? <p role="status" className="text-xs">{t('desktopDownload.aptLoading')}</p> : apt === null ? (
          <p className="text-xs text-muted-foreground">{t('desktopDownload.aptUnavailable')}</p>
        ) : <><p className="text-xs text-muted-foreground">{t('desktopDownload.aptFingerprint')}</p><Commands commands={apt} label={t('desktopDownload.aptCommand')} testId="copy-desktop-apt-command" /></>}
      </section>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span>{t('desktopDownload.connect')} <HelpHint label={t('desktopDownload.connect')}>{t('desktopDownload.connectHelp', { origin: window.location.origin })} {t('common.desktopConnectionHelp')}</HelpHint></span>
        <span>{t('desktopDownload.systems')} <HelpHint label={t('desktopDownload.systems')}>{t('desktopDownload.systemsHelp')}</HelpHint></span>
      </div>
    </DialogBody>
  )
}

export function DesktopDownloadDialog({ trigger, update = false }: { trigger?: ReactElement; update?: boolean } = {}): JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? <Button variant="ghost" size="icon" className="hidden h-8 w-8 text-muted-foreground hover:text-foreground sm:inline-flex" data-testid="app-shell-download-desktop" title={t('desktopDownload.title')} aria-label={t('desktopDownload.open')}>
          <Download className="h-4 w-4" aria-hidden />
        </Button>}
      </DialogTrigger>
      <DialogContent className={cn(dialogMobileSheetClassName, 'h-[min(calc(var(--ak-viewport-h,100dvh)-env(safe-area-inset-top)-env(safe-area-inset-bottom)-1rem),56rem)] min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-5xl')} data-testid="desktop-download-dialog">
        <header className="relative border-b border-border/50 px-4 py-3 pr-14 sm:px-6 sm:pr-14">
          <DialogTitle className="text-base">{t('desktopDownload.title')}</DialogTitle>
          <DialogDescription className="text-xs">{t('desktopDownload.description')}</DialogDescription>
          <DialogClose className={dialogTouchCloseClassName} aria-label={t('desktopDownload.close')}><X className="h-4 w-4" /></DialogClose>
        </header>
        <DownloadContent update={update} />
      </DialogContent>
    </Dialog>
  )
}
