import type { LucideIcon } from 'lucide-react'
import { Check, Copy } from 'lucide-react'
import { createContext, useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../../components/ui/button.js'
import { HelpHint } from '../../components/ui/help-hint.js'
import { cn } from '../../lib/utils.js'
import { writeTextToClipboard } from '../../lib/clipboard.js'
import { notify } from '../../notify.js'

/**
 * Shared, presentational Settings controls. Extracted from SettingsDialog so the
 * individual Section components can live in their own files without duplicating
 * these primitives. Pure UI — no settings state or side effects.
 */

/** Minimal shape a section tab button needs; avoids importing the SECTIONS registry. */
export type SettingsSectionInfo = { key: string; icon: LucideIcon }

export function SettingsSectionButton({
  section,
  active,
  onClick,
}: {
  section: SettingsSectionInfo
  active: boolean
  onClick(): void
}): JSX.Element {
  const { t } = useTranslation()
  const label = t(`settings.sections.${section.key}.label`)
  const hint = t(`settings.sections.${section.key}.hint`)
  const Icon = section.icon
  return (
    <HelpHint label={label} trigger={
    <button
      type="button"
      onClick={onClick}
      data-testid={`settings-tab-${section.key}`}
      className={cn(
        'relative h-9 w-32 flex-none rounded-md px-2.5 text-left text-sm transition-colors sm:w-36 md:w-full',
        active
          ? 'bg-muted/60 text-foreground before:absolute before:-left-[0.6875rem] before:top-1 before:h-7 before:w-0.5 before:rounded-r before:bg-primary'
          : 'border-0 text-muted-foreground shadow-none hover:bg-muted/35 hover:text-foreground',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className={cn('h-4 w-4 flex-none', active ? 'text-primary' : 'text-muted-foreground')} aria-hidden="true" />
        <div className="min-w-0 truncate font-medium">{label}</div>
      </div>
    </button>
    }>{hint}</HelpHint>
  )
}

export const SettingsSectionHelpContext = createContext<((help: string | undefined) => void) | null>(null)

export function SectionHeader({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string
  descriptionKind?: 'help' | 'notice'
}): JSX.Element {
  const setMobileHelp = useContext(SettingsSectionHelpContext)
  useEffect(() => {
    setMobileHelp?.(subtitle)
    return () => setMobileHelp?.(undefined)
  }, [setMobileHelp, subtitle])
  return (
    <div className="hidden min-w-0 md:mb-7 md:block">
      <h3 className="sr-only text-xl font-semibold tracking-[-0.02em] text-foreground md:not-sr-only md:text-2xl">
        {title} {subtitle ? <HelpHint label={title}>{subtitle}</HelpHint> : null}
      </h3>
    </div>
  )
}

export function InterfaceToggle({
  label,
  description,
  checked,
  onChange,
  testId,
  disabled = false,
}: {
  label: string
  description: string
  checked: boolean
  onChange(next: boolean): void
  testId: string
  disabled?: boolean
  descriptionKind?: 'help' | 'notice'
}): JSX.Element {
  return (
    <li className="flex items-center justify-between gap-4 rounded-xl bg-card/70 px-4 py-3.5 ring-1 ring-border/40">
      <div className="min-w-0">
        <div className="flex items-center gap-1 font-medium">{label}<HelpHint label={label}>{description}</HelpHint></div>
      </div>
      <Toggle checked={checked} onChange={onChange} ariaLabel={label} testId={testId} disabled={disabled} />
    </li>
  )
}

export function Toggle({
  checked,
  onChange,
  ariaLabel,
  testId,
  disabled = false,
}: {
  checked: boolean
  onChange(next: boolean): void
  ariaLabel: string
  testId?: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

// ── Layout primitives shared by section bodies ────────────────────────────────

export function EmptyRow({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-muted/15 px-4 py-6 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

export function SettingsKeyValueList({
  rows,
  testId,
}: {
  rows: readonly { label: string; value: React.ReactNode }[]
  testId?: string
}): JSX.Element {
  return (
    <dl className="overflow-hidden rounded-xl bg-card/65 ring-1 ring-border/40" data-testid={testId}>
      {rows.map((row, index) => (
        <div
          key={row.label}
          className={cn(
            'grid min-w-0 gap-1.5 px-3 py-2.5 sm:grid-cols-[minmax(8rem,0.42fr)_minmax(0,1fr)] sm:items-center sm:gap-4',
            index !== rows.length - 1 && 'border-b border-border/50',
          )}
        >
          <dt className="text-xs font-medium text-muted-foreground sm:text-sm sm:text-foreground">{row.label}</dt>
          <dd className="min-w-0 text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function SettingsRecordList({
  children,
  testId,
  className,
}: {
  children: React.ReactNode
  testId?: string
  className?: string
}): JSX.Element {
  return (
    <div className={cn('grid min-w-0 gap-2', className)} data-testid={testId}>
      {children}
    </div>
  )
}

export function SettingsRecord({
  title,
  detail,
  children,
}: {
  title: string
  detail?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="min-w-0 rounded-xl bg-card/65 p-4 ring-1 ring-border/40">
      <div className="min-w-0 border-b border-border/40 pb-2">
        <div className="break-words text-sm font-medium text-foreground [overflow-wrap:anywhere]">{title}</div>
        {detail ? <div className="mt-0.5 break-all font-mono text-caption text-muted-foreground">{detail}</div> : null}
      </div>
      <dl className="mt-2 grid min-w-0 gap-x-4 gap-y-2 sm:grid-cols-2">{children}</dl>
    </div>
  )
}

export function SettingsRecordField({
  label,
  mono = false,
  children,
}: {
  label: string
  mono?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(6rem,0.42fr)_minmax(0,1fr)] items-baseline gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-words text-foreground [overflow-wrap:anywhere]', mono && 'font-mono')}>{children}</dd>
    </div>
  )
}

export function CopyButton({ value }: { value: string }): JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await writeTextToClipboard(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
      notify.error(t('common.copyFailed'))
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-6 w-6 flex-none text-zinc-400 hover:bg-white/10 hover:text-zinc-50"
      aria-label={copied ? t('settings.copy.copied') : t('settings.copy.copyValue')}
      onClick={() => {
        void copy()
      }}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </Button>
  )
}
