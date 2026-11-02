import { ArrowUpCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../components/ui/button.js'
import { HelpHint } from '../components/ui/help-hint.js'
import { useDesktopUpdate } from '../lib/desktop-updates.js'
import { DesktopDownloadDialog } from './DesktopDownloadDialog.js'

export function DesktopUpdateEntry(): JSX.Element | null {
  const { t } = useTranslation()
  const update = useDesktopUpdate()
  if (!update.newer || !update.release) return null
  return <DesktopDownloadDialog update trigger={
    <Button variant="ghost" size="icon" className="h-8 w-8 text-primary" data-testid="desktop-update-available" aria-label={t('desktopUpdate.available', { version: update.release.version })} title={t('desktopUpdate.available', { version: update.release.version })}>
      <ArrowUpCircle className="h-4 w-4" aria-hidden />
    </Button>
  } />
}

export function DesktopUpdateSettings(): JSX.Element {
  const { t } = useTranslation()
  const update = useDesktopUpdate()
  const error = update.error ?? (!update.bridge ? t('desktopUpdate.legacy') : null)
  return (
    <section className="space-y-3 rounded-lg border border-border/50 p-4" aria-label={t('desktopUpdate.title')} data-testid="desktop-update-settings">
      <div className="flex items-center gap-1 text-sm font-medium">{t('desktopUpdate.title')}<HelpHint label={t('desktopUpdate.title')}>{t('desktopUpdate.help')}</HelpHint></div>
      <p className="text-sm">{t('desktopUpdate.installed', { version: update.installedVersion ?? t('desktopUpdate.unknown') })}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!update.installedVersion || update.checking} onClick={() => void update.check()} data-testid="desktop-check-update">{t(update.checking ? 'desktopUpdate.checking' : 'desktopUpdate.check')}</Button>
        {update.newer && update.release ? <DesktopDownloadDialog update trigger={<Button size="sm" data-testid="desktop-open-update">{t('desktopUpdate.available', { version: update.release.version })}</Button>} /> : null}
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{t('desktopUpdate.unavailable', { detail: error })}</p>
        : update.release && !update.newer ? <p role="status" aria-live="polite" className="text-xs text-muted-foreground" data-testid="desktop-update-status">{t(update.manualCheckCompleted ? 'desktopUpdate.currentAfterCheck' : 'desktopUpdate.current')}</p> : null}
    </section>
  )
}
