import { useTranslation } from 'react-i18next'

import type { SessionSummary } from '@agent-kernel/shared'

import { Button } from '../../components/ui/button.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '../../components/ui/alert-dialog.js'

export type GoalAction = 'pause' | 'resume' | 'cancel' | 'complete'

export function GoalStatusBar({
  goal,
  busy,
  onAction,
}: {
  goal: NonNullable<SessionSummary['goal']>
  busy: boolean
  onAction(action: GoalAction): void
}): JSX.Element {
  const { t } = useTranslation()
  const awaitingReview = goal.status === 'completed' && goal.completionSource !== 'user'
  const status = awaitingReview ? t('dialogs.goalStatus.awaitingReview')
    : goal.status === 'completed' ? t('dialogs.goalStatus.accepted')
      : t(`dialogs.goalStatus.${goal.status}`)
  const canControl = goal.status === 'active' || goal.status === 'paused'

  return <section aria-label={t('dialogs.goalStatus.label')}
    className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/50 bg-muted/30 px-4 py-2 text-sm"
    data-testid="goal-status">
    <span className="font-semibold">{t('dialogs.goalStatus.label')}</span>
    <span className="text-muted-foreground">{status} · {t('dialogs.goalStatus.turns', { used: goal.turns, max: goal.maxTurns })}</span>
    <details className="min-w-0 max-w-full grow text-muted-foreground">
      <summary className="max-w-full cursor-pointer truncate text-foreground" title={goal.objective}>{goal.objective}</summary>
      <ScrollArea className="max-h-32">
        <p className="whitespace-pre-wrap break-words py-2">{t('dialogs.goalSuccessCriteria')}: {goal.successCriteria}</p>
      </ScrollArea>
    </details>
    {canControl ? <div className="flex flex-wrap gap-1">
      <Button variant="ghost" size="sm" disabled={busy}
        onClick={() => onAction(goal.status === 'active' ? 'pause' : 'resume')}>
        {t(goal.status === 'active' ? 'dialogs.goalStatus.pause' : 'dialogs.goalStatus.resume')}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAction('complete')}>{t('dialogs.goalStatus.markComplete')}</Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" disabled={busy}>{t('dialogs.goalStatus.end')}</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('dialogs.goalStatus.end')}</AlertDialogTitle>
            <AlertDialogDescription>{t('dialogs.goalStatus.endDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => onAction('cancel')}>{t('dialogs.goalStatus.confirmEnd')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div> : null}
    {awaitingReview ? <Button variant="outline" size="sm" disabled={busy}
      onClick={() => onAction('complete')}>{t('dialogs.goalStatus.accept')}</Button> : null}
  </section>
}
