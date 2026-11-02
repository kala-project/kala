# Dashboard style rules

Concrete rules for surfaces, borders, and separation in the dashboard. Follow these so dark mode stays commercial (Vercel / Linear / Notion vibe) instead of drifting back into "high-contrast wireframe" territory.

Every rule below comes from a real regression the user pushed back on. Don't relax any of them without a matching user request.

---

## 1. The three-surface stack

Panels distinguish themselves through **background luminance**, not lines.

| Token | Dark HSL | Use for |
|---|---|---|
| `--background` | `220 8% 9%` | The chat area, the workbench main column — the darkest surface. |
| `--sidebar` | `220 8% 10%` | The Explorer column and other primary side navigation. |
| `--card` | `220 8% 12%` | The workbench toolbar, the composer, elevated panels. |
| `--muted` | `220 8% 15%` | Todo dock, background terminal, small "raised inside a card" surfaces. |
| `--accent` | `220 8% 20%` | Hover states, subtle highlights. |
| `--border` | `220 8% 18%` | Element outlines and internal dividers (see §2). |

A 3-point lightness step is the minimum readable separation; a 6-point step reads as clearly "another surface". Prefer the smallest step that still communicates the boundary.

The color has a cool blue tint (H=220, S=8%) rather than pure gray. Do **not** revert to `0 0% N%` achromatic values — the resulting dashboard reads as generic/debug, and the user has explicitly rejected that look.

## 2. Border rules — the important part

**Never use a bare `border` or `border-t/-b/-l/-r` at a panel boundary between two large surfaces.** That's the "big white line" the user objects to. Use a background step from §1 instead.

Concrete pattern that comes up over and over:
- Bad: `border-b border-border bg-background` at the top of Composer / Explorer header / Workbench toolbar
- Good: drop the border, set `bg-card` (or `bg-sidebar-accent/60` for lighter surfaces) so the surface itself steps up

For borders that **must exist** (structure inside a card, dialog header/footer, sidebar column edge, chip outlines), use one of these transparency-bracketed variants — never the raw token in dark mode:

| Use case | Class |
|---|---|
| Dialog header/footer divider, dialog outer frame, sidebar column edge, section divider inside a card | `border-border/50` |
| Chip/card outlines that need to be a bit more present (badges on hover, focus states) | `border-border/60` |
| Focus-inside states | `focus-within:border-border` (the full token, only on focus) |

**Bare `border` inherits the full `--border` token** — Tailwind's default. In dark mode at 18% lightness this reads as a bright wireframe. If you write `border` with no color modifier and no adjacent transparency, it *is* the bug.

## 3. Dialogs and popovers

Every modal (`components/ui/dialog.tsx`, `components/ui/alert-dialog.tsx`) and every floating surface (`components/ui/select.tsx`, Composer's `/` and `@` popovers) already:

- Uses `bg-background` (or `bg-popover`) — the darkest surface, so it visibly sits above the darkened backdrop.
- Uses `shadow-lg` — that's the primary depth signal.
- Uses `border border-border/60` — a soft rim to catch the corner, not a wireframe outline.

If you build a new floating surface, mirror those three. Don't reach for `border` alone.

## 4. Alert semantics are separate

`border-amber-*`, `border-rose-*`, `border-emerald-*`, `border-sky-*`, `border-violet-*` carry meaning (warning / error / success / info / activity). Those borders are intentionally more present than `border-border/50`. Do not soften them to match — they *should* pop against the softer neutral chrome. If they feel loud in dark mode, tune the specific `dark:border-*-900/60` value, not the semantic layer.

## 5. Dividers inside a rendered surface (`bg-border` etc.)

`ChatPanel`'s compact-boundary uses `<div className="h-px flex-1 bg-border/60" />` as a horizontal divider. Same rule: never `bg-border` at full opacity — it reads as loud as a `border`. Use `bg-border/60` or lower.

## 6. Kbd chips, hint bars, badges

`<kbd>` in the Composer hint bar (`Enter to send · Shift + Enter for newline` etc.) intentionally has **no border** — only `rounded bg-muted`. The chip is defined by its background against `bg-card`. Adding `border` back makes each keycap heavy and the hint bar looks like a debug legend.

Same principle for other small inline tokens: badge > background > border. Reach for a border only if the two backgrounds are actually indistinguishable.

## 7. Sub-panels inside a panel (`bg-muted/40` inside a card)

Cards inside cards use half-opacity muted (`bg-muted/40`, `bg-muted/60`) to nest without stacking hard borders. Keep the outer card's border and either drop the inner border or use `border-border/50`.

## 8. When you change any of this

- Rebuild + refresh — the CSS is bundled, HMR from a stale dev tab will lie to you.
- Sanity-check in dark mode with the composer, the Explorer, and the New Session dialog open at the same time. That's the "three surfaces + a modal" cross-section where regressions surface fastest.
- Run the existing dashboard tests (`pnpm --filter @agent-kernel/dashboard test`) — they don't test appearance but they catch the class of "I removed a divider that some test grepped for by className" mistake.

## 9. Scrollbars

Never expose native browser scrollbars as raw UI chrome. Scrollable dashboard surfaces should use `components/ui/scroll-area.tsx` so the scrollbar is part of the design system and works consistently in dark and light themes.

Allowed exceptions are content-level overflow inside rendered markdown/code (`pre`, long inline traces), table/diagram previews, editable text, and the document root; those are covered by the global thin scrollbar skin in `src/index.css`. These exceptions concern the content itself, not its surrounding panel. If you add `overflow-auto`, `overflow-y-auto`, or `overflow-x-auto`, either replace it with `ScrollArea` or confirm it is a content-level fallback that will inherit the global skin. Do not leave a large panel, popover, dialog body, list, or terminal output on native scrollbar defaults.

For scroll containers that need imperative control, such as auto-following terminal output, use `ScrollArea`'s `viewportRef` rather than putting `overflow-auto` on the content element.

## 10. Anti-patterns — do not do these

- `border` (bare) — always specify color + transparency
- `dark:border-border` — redundant, the token already adapts; adds noise
- `border-b bg-background` at a panel boundary — the classic wireframe move; use a bg step
- Hardcoded Tailwind gray scales in dark mode (`dark:border-slate-*`, `dark:bg-zinc-*`) — use the semantic tokens instead
- `shadow-sm` in dark mode as a depth signal — nearly invisible; use `shadow-lg` for floaters and background steps for panels
- Achromatic HSL (`0 0% N%`) — reverts to the debug look
- Bare native scrollbars on panels, popovers, dialogs, lists, or terminal output

## 11. Audit command

To find remaining hard borders:

```bash
# bare `border` with no color modifier
rg -n "\bborder\b(?![-a-zA-Z/])" packages/dashboard/src

# `border-border` at full opacity (should be border-border/50 or /60 unless it's a small chip)
rg -n "border-border[^/-]" packages/dashboard/src

# hard directional borders — inspect each hit to decide bg-step vs /50
rg -n "\bborder-[tblr]\b" packages/dashboard/src

# naked overflow scroll containers — replace with ScrollArea unless content-level fallback
rg -n "overflow-(auto|scroll|x-auto|y-auto|x-scroll|y-scroll)" packages/dashboard/src
```

These searches are inspection aids, not exact violation counts. CI uses the token-aware `scripts/style-rules.mjs` helper through `pnpm --filter @agent-kernel/dashboard lint:style` (baseline in `scripts/lint-style.baseline.json`). Explicit soft rims, semantic alert colors, transparent scrollbar gutters and `focus-within:border-border` honor §§2–4; comments are not rendered UI. A directional color cannot excuse an uncolored outline on the other edges. No production or prototype directory is excluded.

Counts may only decrease. Ratchet the baseline down as you clean up hits with `pnpm --filter @agent-kernel/dashboard lint:style -- --write`; the command refuses increases. Focused auditor examples run with `node --test packages/dashboard/scripts/style-rules.test.mjs`.

## 12. Minimum readable typography

Use `text-caption` for the smallest metadata, badges, graph axes and hints, or a larger semantic role for primary content. The caption floor is **12px**, with its semantic line-height; comfortable density and Chinese typography may use larger roles. Do not introduce smaller arbitrary pixel/rem sizes, inline numeric sizes or CSS declarations. Relative font reductions must also respect the caption floor.

Saved font-size indices remain compatible, but historical values below the floor are clamped when displayed. Compact density must not shrink a 12px terminal, file tree or reader below the floor. Keep the 16px root metric, larger touch targets, user-selected larger sizes and sensible line-height.

The typography contract scans production **and prototypes**, CSS and inline numeric font sizes. Browser geometry checks (`scripts/style-browser.mjs`, against the local prototype server with `CHROMIUM_PATH` set to an existing browser) also check rendered text, scrollbar bounds, single-row account actions, portal focus and manual observation refresh.
