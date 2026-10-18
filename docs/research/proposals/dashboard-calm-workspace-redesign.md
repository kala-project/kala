# Dashboard calm workspace redesign

**Status:** implementation design for the September 2026 visual refinement.

This document is intentionally grounded in the current Dashboard code. It does
not propose a new product from memory or screenshots alone. The goal is to turn
the existing Agent RunLab UI into a calmer conversation workspace while keeping
the current working layout, runtime controls, session tree, file tooling, and
diagnostics.

## 1. Current implementation baseline

The Dashboard already has the main product architecture needed for a modern
coding-agent workspace:

| Area | Current source | Existing behavior |
|---|---|---|
| Global topbar | `packages/dashboard/src/app-shell/AppShellNav.tsx` | Sticky dark topbar, product section nav, global actions, account menu, connection status, collapse/expand. Collapsed mode can accept `collapsedContent` and render a full-width fused bar. |
| Main shell | `packages/dashboard/src/app.tsx` | Top-level `ak-app-shell ak-workspace-canvas`, global topbar, left Explorer, central workbench, optional right panel, drawers on narrow layouts. |
| Explorer/sidebar | `packages/dashboard/src/features/explorer/Explorer.tsx` | Workspace/session tree, search, drag ordering, rename, hide, delete, hover preview, online/offline/status indicators, embedded header mode. |
| Chat transcript | `packages/dashboard/src/features/chat/ChatPanel.tsx` | Virtualized transcript. User messages render as right-aligned primary bubbles. Assistant/tool messages render as no-bubble document rows with avatar rail. Tool activity, message actions, images, files, search, and compact status are already implemented. |
| Composer | `packages/dashboard/src/features/chat/Composer.tsx` | Simple/full modes, text input, attachments, slash commands, `@` file mentions, model picker, approval mode, queue/steer, runtime metrics, attention indicator, queued-message dock, send/stop. |
| Code snippets | `packages/dashboard/src/features/chat/CodeBlock.tsx` and `packages/dashboard/src/index.css` | Shiki-based highlighting, small header, copy action, per-line grid rows, gutter/content alignment, streaming-stable raw mode. |
| Product pages | `packages/dashboard/src/components/ui/product-page.tsx`, `features/operations/OperationsPage.tsx`, `features/artifacts-browser/ArtifactsPage.tsx`, `features/artifacts/product-artifact-views.tsx` | Shared product page/header/panel primitives, Operations dashboard metrics, Artifacts inventory/memory panels. |
| Buttons and controls | `packages/dashboard/src/components/ui/button.tsx` and shadcn-style primitives | Semantic variants over the existing HSL token layer. |

The current UI therefore should not be rebuilt as a new layout. The work should
be a visual-system refinement over the existing implementation.

## 2. Problem statement based on code

The code already has many modern pieces, but the visual language is mixed:

1. `index.css` defines `.ak-workspace-canvas` with a radial primary gradient.
   This creates a product-dashboard feel across ordinary work surfaces.
2. `.ak-workspace-surface`, `.ak-navigation-surface`, and
   `.ak-titlebar-surface` use visible borders and long diffuse shadows. This
   makes normal panels feel like stacked cards.
3. `.ak-hero-surface` uses primary/teal gradients and blur. It is appropriate
   for a marketing-like empty state, but too visually loud as a default product
   language.
4. `OperationsPage.tsx` renders four `OpsMetric` cards before the real
   operations panel. This reads like a monitoring dashboard instead of a calm
   operational summary.
5. `Composer.tsx` has useful controls, but its shells use prominent borders,
   blur, and large shadows. It reads as an engineering control panel rather
   than a quiet input hub.
6. `Explorer.tsx` already has the right functionality, but the outer
   `.ak-navigation-surface`, selected row inset border, search ring, and many
   hover surfaces make the sidebar feel heavier than a ChatGPT-like
   Projects/Recents organizer.
7. `CodeBlock.tsx` is structurally correct after the line-alignment fixes, but
   its visual chrome still includes a status dot, uppercase language label,
   outlined copy button, gradient body background, and visible border.

## 3. Design objective

Move the existing Dashboard from:

```text
dashboard canvas
+ heavy product cards
+ visible borders and diffuse shadows
+ gradient hero/surfaces
+ metric tiles
+ always-visible technical controls
```

to:

```text
calm conversation workspace
+ hairline surfaces
+ almost-flat panels
+ typography-first sections
+ dot/chip status
+ composer-centered controls
+ details available in popovers
```

Non-goals:

- Do not remove runtime, workspace, file, git, terminal, artifacts, inspector,
  operations, diagnostics, model, approval, queue, or attention functionality.
- Do not undo the full-width collapsed topbar implementation.
- Do not touch the CodeBlock per-line grid structure that fixed gutter/content
  alignment.
- Do not clone another product's trade dress, icons, or exact layout.
- Do not combine this visual pass with runtime, socket, persistence, or
  executor protocol changes.

## 4. Visual system proposal

### 4.1 Token direction

Current light tokens are cool-blue dashboard neutrals:

```css
--background: 215 30% 96%;
--muted: 214 24% 92%;
--border: 214 20% 83%;
--sidebar: 215 25% 95%;
```

The new light direction should be warm-neutral and less saturated:

```css
--background: 45 22% 97%;
--secondary: 42 18% 93%;
--muted: 42 16% 92%;
--accent: 42 16% 90%;
--border: 38 13% 82%;
--sidebar: 45 18% 95%;
```

The dark direction should remain usable and neutral, with less pure black
contrast than the global topbar:

```css
--background: 220 10% 8%;
--card: 220 9% 13%;
--muted: 220 7% 18%;
--border: 220 7% 24%;
```

The implementation should continue using HSL triples because the existing token
layer and `tailwind.config` expect HSL values.

### 4.2 Surface hierarchy

Use these semantic classes as the visible hierarchy:

| Class | Current use | New role |
|---|---|---|
| `.ak-workspace-canvas` | App/page background with radial gradient | Flat warm-neutral canvas. No default radial gradient. |
| `.ak-workspace-surface` | Major panels and metric cards | Quiet panel: light border, minimal shadow, subtle translucent card background. |
| `.ak-navigation-surface` | Explorer container | Almost flat navigation shelf; less radius/shadow so it feels integrated with the app. |
| `.ak-titlebar-surface` | Toolbar-like surfaces | Hairline title/toolbar surface with very low shadow. |
| `.ak-hero-surface` | Empty-state/cockpit hero | Very subtle warm card; gradients reduced to barely visible accents. |
| `.ak-composer-surface` | New class | Composer shell with calm border, low elevation, focus ring via border/ring instead of large shadow. |
| `.ak-subtle-section` | New utility | Section-first product pages using dividers/spacing instead of boxed cards. |

### 4.3 Border, shadow, and radius

| Element | Current tendency | New rule |
|---|---|---|
| Ordinary panels | `border/60` plus diffuse shadow | `border/25-40`, one `0 1px 2px` shadow at most |
| Popovers/dialogs | `shadow-xl/2xl` | Keep stronger elevation; these are intentional overlays |
| Composer | `shadow-[0_5px_16px...]` and focus shadow | `shadow-[0_1px_2px...]`, focus with ring/border only |
| Explorer selected row | `bg-accent` plus inset border | Softer `bg-accent/55`, no inset ring |
| CodeBlock | border, shadow, header background, body gradient | Hairline border, no body gradient, copy as ghost action |
| Radius | Mixed `rounded-xl`, `2xl`, `3xl`, `[22px]` | Keep existing dimensions where layout depends on them, but make the visual system read as 12/16/20px tiers |

## 5. Textual UI plan by component

### 5.1 Global shell and topbar

Source: `AppShellNav.tsx`, `app.tsx`, `index.css`.

Keep:

- current sticky topbar;
- full-width collapsed topbar via `collapsedContent`;
- compact connection dot in collapsed mode;
- product nav in expanded mode.

Change:

- reduce active nav pill visual weight;
- reduce topbar shadow from a cast shadow to a hairline separation;
- keep global actions quiet, with hover-only visible surface;
- keep dark graphite topbar, but avoid making the rest of the app look like a
  card dashboard underneath it.

Draft:

```text
Agent RunLab    Agent · Operations · Artifacts · Pipeline · Docs       ●  ⌘K  ⚙
───────────────────────────────────────────────────────────────────────────────
```

Collapsed draft:

```text
Agent RunLab    Fix code block alignment                                ●  ⌄
───────────────────────────────────────────────────────────────────────────────
```

### 5.2 Explorer/sidebar

Source: `app.tsx`, `Explorer.tsx`.

Keep:

- workspace/session tree;
- search;
- drag/reorder;
- hidden workspaces/sessions;
- hover preview;
- row actions;
- online/offline/status indicators.

Change:

- make `.ak-navigation-surface` visually part of the sidebar instead of a
  raised card;
- make search input less boxed;
- make workspace rows group headers with weaker hover;
- make selected sessions calmer;
- keep row actions hover-revealed, but reduce their hover fill strength.

Draft:

```text
New chat
Search sessions

Chats
  ● Fix UI quality                         2m
  ○ CPU idle investigation                 1h

akernel
  ● CodeBlock polish                       today
  ○ Large download                         yesterday
```

### 5.3 Chat transcript

Source: `ChatPanel.tsx`.

Keep:

- assistant/tool messages without bubbles;
- user messages as compact primary bubbles;
- virtual transcript;
- tool cards/dots;
- message actions;
- transcript search;
- file/image attachments.

Change:

- reduce assistant avatar gradient/ring/shadow;
- make message action icons quieter until hover/focus;
- reduce tool block backgrounds/borders where possible;
- keep warning/error semantics visible.

Draft:

```text
RunLab
The issue is not the highlighter. The markdown wrapper utilities were leaking
into the nested code block and changing line height.

tsx                                                   Copy
──────────────────────────────────────────────────────────
 1  const alpha = 1
 2  console.log(alpha)
```

### 5.4 Composer

Source: `Composer.tsx`, `composer-redesign-sot.md`.

Keep:

- simple/full mode behavior;
- draft persistence;
- images/files;
- slash commands;
- `@` file mentions;
- model picker;
- approval mode;
- runtime metrics;
- context/attention;
- queue/steer and queued-message dock;
- send/stop semantics.

Change:

- introduce `.ak-composer-surface`;
- replace prominent long shadows with near-flat elevation;
- keep controls, but make default visual state transparent/subtle;
- make focus state read as an active input, not a glowing card;
- keep Send/Stop as the only strong call-to-action.

Draft:

```text
╭────────────────────────────────────────────────────────────────────╮
│ Message the agent - @ for files, / for commands              ↑     │
│ Copilot · Auto      Tools      Files      Approval: Ask             │
╰────────────────────────────────────────────────────────────────────╯
```

### 5.5 Code snippets

Source: `CodeBlock.tsx`, `index.css`.

Keep:

- Shiki;
- per-line grid row;
- gutter/content alignment;
- `<code class="ak-code-line-content">` streaming semantics;
- markdown isolation overrides.

Change:

- remove the decorative status dot;
- display the language as a quiet lower-case/short label where possible;
- make Copy ghost-like by default;
- reduce border/body gradient;
- keep line numbers lower contrast.

Draft:

```text
╭────────────────────────────────────────────────────╮
│ tsx                                          Copy  │
│────────────────────────────────────────────────────│
│  1  export function CodeBlock() {                  │
│  2    return <pre />                               │
│  3  }                                              │
╰────────────────────────────────────────────────────╯
```

### 5.6 Operations and Artifacts

Source: `OperationsPage.tsx`, `ArtifactsPage.tsx`,
`product-artifact-views.tsx`, `product-page.tsx`.

Keep:

- operations/profiles switch;
- ops artifacts;
- session opening from operations;
- artifact inventory;
- memory view;
- stats that help users understand artifact content.

Change:

- replace metric-card wall with a calm summary strip;
- make `ProductPanel` lower elevation;
- use dividers and rows before boxes;
- reserve stronger surfaces for detail drawers/dialogs and error states.

Operations draft:

```text
Operations

Runtime
● local                    loaded

Executors
● 2 executors              14 sessions

Work
● 0 running                0 queued

Attention
● 0 waiting                workspace · artifacts · terminal

────────────────────────────────────────────────────────────────────
Ops artifacts
...
```

Artifacts draft:

```text
Artifacts

Inventory
files 42     bytes 18 MB     hashed 40/42

────────────────────────────────────────────────────────────────────
trace.json         trace          112 KB        9f2ac8d1
report.md          markdown        28 KB        a0c129ef
```

## 6. Implementation plan

1. Commit or confirm the current working state before changing files.
2. Add this design document.
3. Update `index.css` tokens and shared surface classes.
4. Add `.ak-composer-surface` and apply it in `Composer.tsx`.
5. Reduce topbar active pill and global surface shadows in `AppShellNav.tsx`.
6. Reduce Explorer shell/search/selected-row visual weight.
7. Change Operations metric cards to calmer summary surfaces.
8. Polish CodeBlock chrome without changing line layout.
9. Run targeted tests and typecheck.
10. Use real browser screenshots to compare active chat, no-session cockpit,
    operations, artifacts, collapsed topbar, composer, and code snippets.
11. Repeat checks three times before production deployment.

## 7. Acceptance checklist

- Existing core layout remains: topbar, explorer, workbench, optional right
  panel, composer, drawers.
- Collapsed topbar remains full-width and does not stretch vertically.
- Connection status compact mode remains dot-only.
- Composer still supports simple/full, attachments, slash commands, file
  mentions, model selection, approval, queue/steer, runtime metrics, attention,
  send, and stop.
- CodeBlock gutter/content alignment remains exact in a real browser.
- Assistant messages remain document-like; user messages remain visually
  distinct.
- Operations and Artifacts keep their data and actions while reducing dashboard
  card weight.
- Light and dark themes remain readable.
- Mobile/tablet layouts do not overflow.
- TypeScript and targeted tests pass.
- Production deployment exposes the new dashboard generation and screenshots
  match the intended visual direction.
