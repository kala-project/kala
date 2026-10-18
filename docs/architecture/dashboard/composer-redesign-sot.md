# Composer redesign SOT

## Status

Approved implementation basis. This document turns the Composer visual concepts into implementable constraints. The reference images are:

- `composer-redesign-current-theme.png`: full desktop composition and detailed popovers.
- `composer-redesign-current-theme-mobile.png`: phone idle, running, keyboard, and settings states.
- `composer-mode-matrix-desktop.png`: Desktop Simple/Full parity.
- `composer-mode-matrix-touch.png`: Phone and iPad Simple/Full parity.

## Objective

Modernize the Composer without replacing the Dashboard theme or removing professional controls. Simple and Full are presentation densities over the same state, not separate editors.

## Theme constraints

- Use existing semantic tokens (`background`, `card`, `popover`, `primary`, `muted`, `accent`, `border`, `ring`).
- Do not introduce a Composer-only blue-black palette.
- Preserve light, dark, system, and VS Code theme compatibility.
- The primary color is reserved for Send/Steer/Queue and focused/selected state.
- Normal controls use transparent or subtle accent surfaces; permanent bright outlines are prohibited.

## Control proportions

Visible surfaces are smaller than touch hit targets.

| Control | Desktop visible height | Touch visible height | Minimum touch target | Radius |
|---|---:|---:|---:|---:|
| Text/config button | 28–30 px | 32–34 px | 44 px | 7–10 px |
| Icon button | 28 px | 32–36 px | 44 px | 8–10 px or circle |
| Send/Stop | 32–36 px | 36–40 px | 44 px | pill/circle |
| Segmented option | 28–30 px | 32–34 px | 44 px | 8–10 px |

- Model, Approval, Tasks, and Shell must not all look like heavy pills.
- Desktop secondary controls default to transparent or a very subtle surface; hover, focus, and pressed states may reveal a stronger surface.
- Full mode uses the compact Context ring and percentage. Simple mode renders a clickable, segmented Context stroke along the Composer’s own upper rounded border; User, Assistant, and Tool-result segments share one measured SVG path and the exact percentage remains in the popover.
- Typography is 12 px minimum for visible control labels on desktop and 12–13 px on touch layouts.

## Shared behavior

Simple and Full share:

- session-scoped draft;
- caret intent and input focus;
- pasted images;
- `@` Workspace file mentions;
- slash commands;
- selected model;
- approval mode;
- Steer/Queue send mode;
- queued messages and queue mutations;
- context pressure and compaction;
- Human Attention state;
- Tasks/Shell extras;
- Send and Stop semantics;
- pending/error feedback.

Switching modes changes presentation only. It must not clear or replace any shared state, scroll the page unexpectedly, or create a second input owner.

## Simple mode

### Desktop and iPad

- Compact capsule with one auto-growing input row.
- Inline image tokens remain editable/removable.
- Always expose mode toggle, input, the border-integrated Context trigger, attachment/config access, and one Send/Stop button.
- Model and approval are summarized by a lightweight settings control.
- Queue summary appears above the capsule only when relevant. Agent Activity belongs to the transcript tail, not the Composer surface.
- Settings opens an anchored popover on pointer layouts.

### Phone

- Use a two-level structure: input area plus one compact action row.
- Visible controls are mode, input, config, the border-integrated Context trigger, and one Send/Stop button.
- Settings opens a bottom sheet.
- Queue opens a touch-native review sheet/card instead of reproducing desktop drag controls.

## Full mode

### Desktop

- One coherent surface with an auto-growing input and a quiet footer toolbar.
- Footer exposes mode toggle, Model, Approval, Tasks/Shell extras, Context, Human Attention when meaningful, and Send/Stop.
- Steer/Queue remains available through the Full-mode send split control. Simple mode keeps one send button and moves Steer/Queue selection into config.
- Image tray is shown above input content.
- Model/Approval controls use compact text-button geometry rather than full-height pills.

### iPad

- Use one complete toolbar when horizontal space permits.
- Preserve 44 px hit targets while keeping visible control surfaces compact.
- If controls no longer fit, wrap once into an intentional second row; do not horizontally clip the footer.

### Phone

- Use two intentional touch rows, not a compressed desktop footer.
- First row: attach/config, model, approval.
- Second row: Tasks/Shell extras, Context/Attention, Send/Stop.
- Steer/Queue appears as a compact tertiary row or within the settings sheet.
- The input keeps a useful minimum height and cannot be reduced to a narrow strip by controls.

## Queue and runtime status

- Queue Dock remains separate from the editor surface.
- Normal idle state renders no status rail.
- Connection, pending, and error feedback use concise dedicated surfaces.
- Agent Activity is a transcript-tail badge. It shows the real runtime state and, when available, the current or immediately preceding persisted Tool Intention without duplicating Dot Line text.
- Queue summary is collapsed by default on touch layouts and can be expanded without destroying input focus.
- Desktop queue editing, reorder, delete, pending, and retry behavior remains available.

## Input overlays

- `@` mention and slash-command menus use Popover surface tokens and align with the input content edge.
- Menus must remain within the visual viewport and above the software keyboard.
- Keyboard navigation, active option, Enter/Tab apply, and Escape dismiss remain supported.
- Context and send-mode popovers use the same elevation, radius, and spacing language.

## Responsive and PWA behavior

- Composer follows `visualViewport` when the software keyboard opens.
- PWA bottom padding accounts for `safe-area-inset-bottom` without creating an oversized shelf.
- Focus does not scroll the layout viewport to the top.
- Opening settings, queue, context, or send mode restores focus appropriately on close.
- All touch actions have at least a 44×44 px hit target even when their visible surfaces are smaller.

## Acceptance criteria

1. Current theme tokens remain the source of all Composer colors.
2. Desktop and touch layouts implement both Simple and Full modes.
3. Button surfaces match the proportion table and no secondary toolbar becomes a row of heavy pills.
4. Mode switching preserves draft, images, model, approval, send mode, queue, and focus intent.
5. Send, Stop, Steer, and Queue semantics are unchanged.
6. `@` mentions, slash commands, pasted images, queue mutations, context details, and compaction remain functional.
7. Phone Full uses touch-specific rows and never horizontally overflows.
8. iPad portrait/landscape and standalone PWA do not clip Composer or hide it behind the software keyboard.
9. Existing Composer unit tests pass and focused responsive browser tests cover both modes.
10. Production build and PWA build pass before deployment.
