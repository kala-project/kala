import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { HelpHint } from '../../components/ui/help-hint.js'

export function SizePreference({ label, description, value, onChange, min, max, defaultValue, unit, testId }: {
  label: string
  description: string
  value: number
  onChange(value: number): void
  min: number
  max: number
  defaultValue: number
  unit: string
  testId: string
}): JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return (
    <li className="flex flex-col gap-3 rounded-md bg-card/60 px-4 py-3 ring-1 ring-border/50">
      <div className="flex min-w-0 items-center gap-1 font-medium">
        {label}<HelpHint label={label}>{description}</HelpHint>
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(3rem,4.5rem)_auto_2rem] items-center gap-1 sm:gap-2">
        <input
          type="range" min={min} max={max} step={1} value={value}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          aria-label={label} aria-valuetext={`${value}${unit}`}
          data-testid={`${testId}-slider`}
          className="w-full min-w-0 accent-primary"
        />
        <input
          type="number" min={min} max={max} step={1} value={draft}
          aria-label={label} data-testid={testId}
          onChange={(event) => {
            const next = event.currentTarget.value
            setDraft(next)
            const parsed = Number(next)
            if (next !== '' && Number.isInteger(parsed) && parsed >= min && parsed <= max) onChange(parsed)
          }}
          onBlur={() => {
            const parsed = draft.trim() === '' ? value : Number(draft)
            const next = Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : value
            setDraft(String(next))
            onChange(next)
          }}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          className="h-8 w-full min-w-0 rounded-md bg-background px-1 text-sm ring-1 ring-border/70"
        />
        <span className="text-xs text-muted-foreground">{unit}</span>
        <button
          type="button" onClick={() => { setDraft(String(defaultValue)); onChange(defaultValue) }}
          aria-label={t('settings.interface.resetSize', { label })}
          title={t('settings.interface.resetSize', { label })}
          className="flex h-8 w-8 flex-none items-center justify-center rounded-md hover:bg-accent"
          data-testid={`${testId}-reset`}
        >
          <RotateCcw className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </li>
  )
}
