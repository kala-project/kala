/**
 * Global command palette. Opens via ⌘K / Ctrl+K and lets the user reach any
 * registered app-level action from anywhere in the UI. Grouped, keyboard
 * navigable, fuzzy-searched via `cmdk`.
 *
 * Design notes:
 *
 *   - The palette does **not** own its command list. Callers build the list
 *     (usually in `app.tsx` where handlers are in scope) and pass it as
 *     `commands`. This keeps the palette a pure view — it never imports
 *     anything session-specific.
 *
 *   - `group` sorts commands into `cmdk` `CommandGroup`s; commands without a
 *     group fall under `Actions`. Consistent group names across a build
 *     produce a stable order because we sort them at render time.
 *
 *   - `keywords` extend fuzzy matching without polluting the visible label.
 *     Useful for aliases (e.g. `theme` also matches `dark`/`light`).
 *
 *   - `shortcut` is display-only. The actual key handler is wherever the caller
 *     wires the shortcut (usually `useEffect(document.keydown)` in app.tsx).
 *     We render `⌘` on Mac, `Ctrl` elsewhere.
 *
 *   - Focus restoration: we snapshot `document.activeElement` on open and
 *     restore it on close (unless the user tabbed away). Prevents "run
 *     command → lose composer focus" traps.
 *
 * Backwards compatibility: the `disabled`/`disabledReason` fields from the
 * previous home-grown palette still work — disabled commands are rendered
 * dimmed with the reason as their hint and their `run` is not called.
 */

import { useEffect, useMemo, useRef } from 'react'
import { Command } from 'cmdk'
import { Search, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog.js'
import { cn } from '../../lib/utils.js'
import { ScrollArea } from '../../components/ui/scroll-area.js'

export type CommandPaletteItem = {
  id: string
  label: string
  hint: string
  disabled?: boolean
  disabledReason?: string
  group?: string
  keywords?: readonly string[]
  shortcut?: readonly string[]
  icon?: LucideIcon
  run(): void | Promise<void>
}

type Props = {
  open: boolean
  onOpenChange(open: boolean): void
  commands: readonly CommandPaletteItem[]
}

const DEFAULT_GROUP_KEY = '__default__'
const DEFAULT_GROUP_LABEL = 'Actions'

export function CommandPalette({ open, onOpenChange, commands }: Props): JSX.Element {
  const { t } = useTranslation()
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (open) {
      const active = document.activeElement
      previouslyFocused.current = active instanceof HTMLElement ? active : null
      return
    }
    // On close, hop focus back to whatever had it before we opened.
    const target = previouslyFocused.current
    previouslyFocused.current = null
    if (!target || !document.contains(target)) return
    // Defer so Radix's dialog cleanup doesn't immediately steal focus back.
    const raf = requestAnimationFrame(() => target.focus())
    return () => cancelAnimationFrame(raf)
  }, [open])

  const grouped = useMemo(() => groupCommands(commands), [commands])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="ak-command-palette top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden border-border/55 p-0 shadow-2xl"
        data-testid="command-palette"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t('commandPalette.title')}</DialogTitle>
          <DialogDescription>{t('commandPalette.description')}</DialogDescription>
        </DialogHeader>
        <Command
          label={t('commandPalette.title')}
          shouldFilter
          loop
          className="flex flex-col"
        >
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <Search className="h-4 w-4 flex-none text-muted-foreground" aria-hidden="true" />
            <Command.Input
              placeholder={t('commandPalette.searchPlaceholder')}
              className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              data-testid="command-palette-search"
              autoFocus
            />
          </div>
          <ScrollArea className="max-h-80"><Command.List className="p-1">
            <Command.Empty className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t('commandPalette.empty')}
            </Command.Empty>
            {grouped.map(({ group, items }) => (
              <Command.Group
                key={group}
                heading={isDefaultGroup(group) ? t('common.actions') : group}
                className={cn(
                  'px-1 py-1',
                  '[&_[cmdk-group-heading]]:mb-0.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground',
                )}
              >
                {items.map((command) => (
                  <PaletteRow
                    key={command.id}
                    command={command}
                    onRun={() => {
                      if (command.disabled) return
                      onOpenChange(false)
                      void command.run()
                    }}
                  />
                ))}
              </Command.Group>
            ))}
          </Command.List></ScrollArea>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

function PaletteRow({
  command,
  onRun,
}: {
  command: CommandPaletteItem
  onRun: () => void
}): JSX.Element {
  const Icon = command.icon
  const hint = command.disabled ? command.disabledReason ?? command.hint : command.hint
  return (
    <Command.Item
      value={buildValue(command)}
      keywords={command.keywords ? [...command.keywords] : undefined}
      disabled={command.disabled}
      onSelect={onRun}
      className={cn(
        'flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-xs transition-[background-color,border-color,box-shadow]',
        'data-[selected=true]:border-border/45 data-[selected=true]:bg-background/75 data-[selected=true]:text-accent-foreground data-[selected=true]:shadow-[inset_0_1px_0_hsl(var(--background)/0.9),0_5px_18px_hsl(var(--foreground)/0.05)]',
        command.disabled && 'cursor-not-allowed opacity-45',
      )}
      data-testid={`command-palette-item-${command.id}`}
    >
      {Icon ? <Icon className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden="true" /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-foreground">{command.label}</span>
        <span className="mt-0.5 truncate text-caption text-muted-foreground">{hint}</span>
      </div>
      {command.shortcut && command.shortcut.length > 0 ? (
        <span className="flex flex-none items-center gap-0.5 text-caption text-muted-foreground">
          {command.shortcut.map((k, i) => (
            <kbd
              key={i}
              className="rounded border border-border/70 bg-muted/60 px-1 py-0.5 font-mono uppercase"
            >
              {k}
            </kbd>
          ))}
        </span>
      ) : null}
    </Command.Item>
  )
}

/**
 * Build the `value` cmdk uses for match ranking. Include id + label + hint +
 * keywords so ranking sees the full context. Newlines are collapsed since
 * cmdk uses whitespace as a token separator.
 */
function buildValue(command: CommandPaletteItem): string {
  const parts = [command.id, command.label, command.hint]
  if (command.keywords) parts.push(...command.keywords)
  return parts.join(' ').replace(/\s+/g, ' ')
}

function groupCommands(
  commands: readonly CommandPaletteItem[],
): ReadonlyArray<{ group: string; items: readonly CommandPaletteItem[] }> {
  const buckets = new Map<string, CommandPaletteItem[]>()
  for (const cmd of commands) {
    const g = cmd.group ?? DEFAULT_GROUP_KEY
    const bucket = buckets.get(g)
    if (bucket) bucket.push(cmd)
    else buckets.set(g, [cmd])
  }
  const order = [...buckets.keys()].sort((a, b) => {
    if (isDefaultGroup(a)) return 1
    if (isDefaultGroup(b)) return -1
    return a.localeCompare(b)
  })
  return order.map((group) => ({ group, items: buckets.get(group) ?? [] }))
}

function isDefaultGroup(group: string): boolean {
  return group === DEFAULT_GROUP_KEY || group === DEFAULT_GROUP_LABEL
}

/**
 * Renders the platform-appropriate glyph for the ⌘/Ctrl modifier. Consumers
 * assemble the whole shortcut array themselves (e.g. `[modKey(), 'K']`).
 */
export function modKey(): '⌘' | 'Ctrl' {
  if (typeof navigator === 'undefined') return 'Ctrl'
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘' : 'Ctrl'
}
