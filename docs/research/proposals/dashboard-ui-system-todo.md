# Dashboard UI system redesign TODO

**Status:** derived implementation plan and status ledger; non-normative. Topic-specific SOTs such as Composer and Tool Card contracts take precedence.

> Status: approved source of truth; implementation in progress
>
> This document defines the design direction, implementation sequence, acceptance criteria, and regression gates for the Dashboard UI redesign. Product UI changes must conform to it.

## 0. Implementation baseline (2026-08-21)

Already implemented and retained as the baseline:

- floating session navigation, session title surface, and Composer;
- unified right Sidebar entry point for Files, Git, Terminal, and Inspector;
- independent Dashboard release/deployment with generation-fenced receipts;
- semantic `ProductState` states and shared workspace/navigation/title surfaces;
- responsive phone/tablet drawers, safe-area handling, and durable session view state;
- paginated artifact loading and structured file preview;
- separate selected/running/waiting/error session semantics.

Current implementation tranche:

1. shared product-page header, navigation, content, and section primitives;
2. Operations, Product Outputs, Pipeline, Memo, Docs, and Settings surface convergence;
3. consistent loading, empty, offline, degraded, and error presentation;
4. English/Chinese, keyboard, responsive, contrast, and real-browser acceptance.

Activity and Composer presentation are fixed by these additional rules:

- a persisted Tool Intention is the activity card's primary copy; run, success,
  failure, and approval are conveyed by icon, color, motion, and compact timing,
  never by lifecycle prose prefixed to the Intention;
- `Thinking` and `Working` are fallbacks only when no persisted Intention exists;
- the activity card and Dot Line never show the same Intention simultaneously;
- the Composer context outline uses one color selected from the aggregate
  pressure level; contribution colors exist only inside the opened breakdown;
- the Composer context outline is one open, continuous upper-cap path: left
  shoulder, top edge, and right shoulder only. It never draws the lower sides
  or bottom edge. Its neutral track and aggregate-pressure used portion share
  that exact geometry; separate fragments and periodically repeated dash
  patterns must never be stitched together;
- the transcript exposes compact previous/next user-message controls on its
  left edge. Navigation is relative to the real scroll viewport measured from
  rendered row geometry, never Virtuoso's overscan-inclusive range. It targets
  top-level user messages only, aligns each target at the viewport top, supports
  rapid repeated clicks, and disables the unavailable direction at boundaries;
- activity and Composer elevation stays compact: motion and glow must not extend
  far beyond the owning surface.

Checkboxes below are acceptance inventory. An unchecked historical item is not evidence that an already implemented capability should be rebuilt; verify current behavior first.

## 1. Objective

Build a coherent visual and interaction system for a professional coding agent:

- Preserve IDE-grade capability and useful information density.
- Reach consumer-product-level polish in controls, typography, surfaces, motion, and touch behavior.
- Keep Files, Git, Terminal, Inspector, sessions, tool activity, connection health, and workspace installation available without making every element visually dominant.
- Make desktop, phone, iPad, browser, and standalone PWA first-class layouts.
- Treat state correctness, keyboard/focus behavior, and connection reliability as prerequisites for visual quality.

Guiding statement:

> Professional complexity is acceptable; accidental visual complexity and inconsistent behavior are not.

## 2. Non-goals

- Do not simplify the product into a chat-only interface.
- Do not remove professional diagnostics; place them at the appropriate disclosure level.
- Do not copy another product's trade dress, proprietary assets, or exact layouts.
- Do not replace working domain logic merely to restyle it.
- Do not combine connection architecture changes with broad visual changes unless a verified state-model defect requires it.
- Do not deploy until the applicable verification and real-device gates pass.

## 3. Design principles

### P1 — Complex information, restrained presentation

- Complexity must come from useful information, not decoration.
- Default containers use surfaces, spacing, and typography rather than visible borders.
- High-contrast outlines are reserved for keyboard focus, warnings, and errors.
- Nested DOM structure must not automatically create nested cards.

### P2 — One primary visual signal per meaning

Use separate visual dimensions for separate meanings:

| Meaning | Primary signal |
|---|---|
| Selected | Background/surface change |
| Running | Status dot |
| Unread or needs attention | Attention dot/count |
| Warning/error | Semantic icon and color |
| Keyboard focus | Focus ring |
| Disabled | Reduced contrast, with preserved readability |

Do not express one state simultaneously through border, background, badge, icon, and colored text.

### P3 — Information disclosure follows frequency

- Level 1: normal workflow and essential status.
- Level 2: details opened intentionally by the user.
- Level 3: protocol and troubleshooting diagnostics.

Example for connection health:

- Level 1: `Connected · 42 ms`.
- Level 2: Host, Executor, last response, concise error, reconnect action.
- Level 3: socket, subscription, ACK, cursor, generation, and protocol diagnostics.

### P4 — Shared semantics use shared components

The same semantic control must not have different implementations and states in different features. Shared components must cover:

- Button and IconButton
- Input, Select, and SegmentedControl
- Tabs
- Tooltip, Popover, Modal, and Drawer
- Toast and inline feedback
- StatusIndicator
- Empty, loading, offline, and error states
- Toolbar and TreeRow

### P5 — Responsive behavior is explicit

- Desktop, compact desktop, iPad landscape, iPad portrait, phone, and standalone PWA have documented layouts.
- Phone and iPad must not be treated as compressed desktop layouts.
- Overlay drawers do not resize the main content.
- Left and right drawers are mutually exclusive on touch layouts.
- Safe areas, dynamic viewport height, virtual keyboards, pointer type, and orientation are handled explicitly.

### P6 — State correctness precedes polish

- Selected session, running session, workspace connection, and tool availability are independent states.
- A session switch must not recreate a workspace-level physical socket.
- Loading, empty, offline, stale, and error are distinct states.
- Terminal focus and input must survive supported panel transitions.
- Motion must never conceal reconnection, data loss, stale content, or input failure.

### P7 — Accessibility is part of the element design

- Controls have accessible names and visible keyboard focus.
- Touch targets are at least 44×44 CSS pixels on touch layouts.
- Text and semantic state colors meet contrast requirements.
- Color is never the only state signal.
- Reduced-motion and platform text scaling are supported.

## 4. Proposed visual system

### 4.1 Surface hierarchy

Use no more than these semantic layers:

1. `canvas` — primary session content.
2. `navigation` — workspace/session navigation.
3. `panel` — workspace tools.
4. `control` — interactive control background.
5. `elevated` — modal, drawer, and popover.

Rules:

- Ordinary containers have no visible outline.
- Use one subtle divider only where spatial separation is otherwise ambiguous.
- Inputs use a control surface and an accent focus ring rather than a permanent white border.
- Modal and drawer separation comes from elevation, surface contrast, radius, and scrim.

### 4.2 Color tokens

TODO:

- [ ] Audit every current literal color and classify its semantic purpose.
- [ ] Define canvas, navigation, panel, control, elevated, hover, pressed, and selected surface tokens.
- [ ] Define primary, secondary, muted, and disabled text tokens.
- [ ] Define accent, success, warning, danger, and informational tokens.
- [ ] Define subtle divider and focus-ring tokens.
- [ ] Define equivalent light-theme tokens if light theme remains supported.
- [ ] Remove opaque white borders from ordinary containers.
- [ ] Verify contrast in default, hover, pressed, selected, focused, and disabled states.

### 4.3 Radius tokens

Allowed radius levels:

- `8px`: compact controls and tree rows.
- `12px`: regular controls and selected rows.
- `16px`: panels and compact popovers.
- `24px`: modals and touch drawers.
- `999px`: circular and pill controls only.

TODO:

- [ ] Inventory arbitrary radii.
- [ ] Map each existing component to one semantic level.
- [ ] Remove radius stacking where nested elements produce inconsistent corners.

### 4.4 Spacing and density

Base spacing scale: `4 / 8 / 12 / 16 / 20 / 24 / 32`.

- Icon-to-label gap: 8px.
- Related control gap: 8–12px.
- Desktop row height: 36–40px where density matters.
- Touch row/target height: at least 44px.
- Desktop panel padding: 16px.
- Touch panel padding: 20px unless available space requires a documented compact variant.

TODO:

- [ ] Audit arbitrary margins, gaps, and paddings.
- [ ] Define comfortable and compact density modes without changing semantic hierarchy.
- [ ] Check localization and long workspace/session names at every supported width.

### 4.5 Typography

Proposed roles:

| Role | Target |
|---|---|
| Page title | 20–24px, semibold |
| Panel title | 15–16px, semibold |
| Body | 14px, regular |
| Control label | 13–14px, medium |
| Metadata | 12px, regular |
| Code/terminal | Product monospace stack |

TODO:

- [ ] Define line heights and truncation/wrapping rules for every role.
- [ ] Limit simultaneous weights in one view.
- [ ] Use monospace only for code, commands, identifiers, and protocol diagnostics.
- [ ] Verify Chinese, Latin, emoji fallback, and code font alignment.

### 4.6 Icons

TODO:

- [ ] Select one primary icon family and document permitted exceptions.
- [ ] Normalize optical size and stroke weight.
- [ ] Standardize 18–20px visible icon sizes.
- [ ] Standardize 36px desktop and 44px touch IconButton targets.
- [ ] Replace emoji and inconsistent platform glyphs with coherent Windows, Apple, and Linux marks.
- [ ] Ensure icons without text have accessible labels and tooltips where appropriate.

### 4.7 Motion

Proposed timing:

- Hover/press: 100–140ms.
- Popover: approximately 160ms.
- Drawer: 220–280ms.

TODO:

- [ ] Define shared easing tokens.
- [ ] Implement reduced-motion behavior.
- [ ] Avoid decorative animation for terminal output, connection latency, and session runtime state.
- [ ] Ensure drawer/modal animation never races focus placement or teardown.

## 5. Product layout specification

### 5.1 Desktop

- Left navigation: workspaces and sessions only.
- Center: session stream, tool activity, and Composer.
- Right workspace tools: Files, Git, Terminal, and Inspector in one panel.
- Connection health remains compact in the top-level chrome and expands on demand.
- Right-tool state, scroll positions, and Terminal instance persist across supported tab changes.

### 5.2 Compact desktop

- Preserve the center task area.
- Allow the right tools panel to collapse rather than squeeze Terminal or Composer below usable widths.
- Use an explicit trigger to reopen the tools panel.
- Avoid icon-only conversion unless labels remain available through tooltips and accessible names.

### 5.3 iPad and touch tablets

- Use an overlay drawer for workspace tools by default.
- Permit a pinned tools panel only when the documented width and orientation threshold is met.
- Left navigation and right tools drawer are mutually exclusive.
- Opening a drawer does not resize the center content.
- Scrim click/tap closes the drawer unless a blocking operation explicitly prevents dismissal.
- PWA standalone mode must respect top, side, and bottom safe areas.

### 5.4 Phone

- Show one primary region at a time.
- Navigation and workspace tools use separate, mutually exclusive drawers/sheets.
- Keep Composer reachable above the virtual keyboard.
- Do not show a compressed three-column layout.
- Preserve a clear path back to the session after opening a tool.

## 6. Feature-specific TODOs

### 6.1 App shell and navigation

- [ ] Remove duplicate Files and Git entry points from the left navigation.
- [ ] Define consistent workspace and session row anatomy.
- [ ] Express selected, running, unread, waiting, and error states independently.
- [ ] Reveal secondary row actions on hover/focus for pointer layouts; provide an explicit touch action.
- [ ] Preserve list scroll and selection through drawer transitions.
- [ ] Handle long names without moving status and action controls unpredictably.

Acceptance criteria:

- Selected and running are never conflated.
- Switching sessions does not change another session's runtime indicator incorrectly.
- Session switching does not recreate the workspace physical socket.
- Navigation remains operable by keyboard, touch, and screen reader.

### 6.2 Center session experience

- [ ] Define stable widths and spacing for message content, tool activity, and Composer.
- [ ] Use consistent activity rows for tool calls.
- [ ] Present intention as the primary description and status/duration as metadata.
- [ ] Provide a safe fallback intention when providers or historical records omit it.
- [ ] Keep raw tool payload and detailed parameters collapsed by default.
- [ ] Distinguish waiting for Host, waiting for user, queued, running, and failed states.

Acceptance criteria:

- No supported tool call renders a blank intention area.
- Composer does not remain on `Waiting for Host` while the selected workspace is usable.
- Tool activity remains understandable without exposing raw protocol fields by default.

### 6.3 Workspace tools panel

- [ ] Unify Files, Git, Terminal, and Inspector under one panel and tab system.
- [ ] Give each tool one toolbar immediately below the shared tabs.
- [ ] Remove redundant cards around tool content.
- [ ] Preserve per-tool state, scroll position, selection, and terminal process/view state.
- [ ] Define loading, empty, offline, stale, and error presentation for each tool.
- [ ] Ensure iPad/PWA drawer geometry, corners, scrim, and safe-area padding remain correct in both orientations.

Acceptance criteria:

- Files and Git display workspace data after session switching and network recovery.
- Only one tools location exists in the product shell.
- The panel never overlaps or clips its own toolbar/tabs at supported viewport sizes.
- Touch drawer open/close behavior does not destroy tool state.

### 6.4 Terminal

- [ ] Audit the complete input path: pointer event, focus, xterm input, transport event, Executor PTY, output echo.
- [ ] Define explicit focus ownership when opening Terminal, switching tool tabs, switching sessions, and closing drawers.
- [ ] Cover printable characters, Enter, Backspace, Tab, arrows, modifiers, paste, IME, and mobile software keyboards.
- [ ] Keep the terminal viewport measurable and visible when the virtual keyboard opens.
- [ ] Provide a clear disconnected/read-only state rather than silently accepting unusable focus.
- [ ] Verify the Unix PTY fallback and native PTY paths separately where both are supported.

Acceptance criteria:

- A real command can be typed, submitted, executed, and observed end-to-end.
- Terminal input works on desktop browser, iPad browser/PWA, and phone browser/PWA.
- Switching tools or sessions according to documented behavior does not leave an apparently focused but nonfunctional terminal.
- Enter, Backspace, paste, and common control sequences have dedicated regression tests.

### 6.5 Connection health

Default presentation:

- Semantic status indicator.
- Human-readable state.
- Executor round-trip latency when measurable.

Expanded presentation:

- Host reachability.
- Executor reachability.
- Last successful response.
- Concise failure reason.
- Relevant recovery action.

Diagnostics-only presentation:

- Socket, logical subscription, ACK, cursor, generation, and raw timing information.

TODO:

- [ ] Define the state machine and source of truth for every displayed status.
- [ ] Measure Host-to-Executor RTT using a reliable request/response path.
- [ ] Separate unknown/not-yet-measured from timeout and disconnected.
- [ ] Remove user-facing labels such as raw cursor values from normal and expanded views.
- [ ] Make recovery actions enabled only when valid and give immediate feedback.
- [ ] Prevent selected-session changes from resetting workspace connection health.

Acceptance criteria:

- A usable Executor does not remain shown as `no response`.
- `Last disconnect` is omitted or labeled as unavailable when no disconnect is known.
- Latency has a documented measurement source and freshness window.
- Weak-network recovery converges to the correct state without duplicate physical sockets.

### 6.6 Connect Workspace modal

Required structure:

1. Title and one short explanation.
2. Operating system selection.
3. Manual/service run-mode selection.
4. One-line command.
5. Copy action.
6. Connection/install status.

TODO:

- [ ] Replace heavy outlines with surface hierarchy and one focused command surface.
- [ ] Add coherent platform icons.
- [ ] Remove workspace-root input and unnecessary explanatory copy.
- [ ] Ensure OS and run-mode changes immediately produce visibly different applicable commands.
- [ ] Keep installation logic behind stable `/install*` public endpoints.
- [ ] Keep dynamic credentials out of URLs.
- [ ] Avoid a second manual code/pairing step for the Dashboard-managed installation flow.
- [ ] Close on scrim interaction when no blocking operation is active.
- [ ] Use a centered modal on desktop/tablet and an appropriate sheet treatment on phone.
- [ ] Verify commands for Linux, macOS, Windows PowerShell, manual mode, and service mode.

Acceptance criteria:

- Every displayed command returns a valid installer response through the production routing model.
- Switching OS or mode changes the command when platform/run behavior differs.
- Copy always copies the currently visible command.
- No URL contains a dynamic invite, setup, claim, or bearer credential.
- The command uses the current directory as workspace root and the runtime reports the resolved root.
- Dismissal works by close control, Escape where applicable, and scrim interaction.

## 7. Component work plan

### Phase A — Audit and baselines

- [ ] Record current screenshots for all target viewports and primary states.
- [ ] Inventory literal colors, borders, shadows, radii, spacing, typography, and z-index values.
- [ ] Inventory duplicate controls and feature-local variants.
- [ ] Map every visible state to its domain source of truth.
- [ ] Record existing automated coverage and known failures without changing baselines.

Deliverables:

- Visual inventory.
- Component duplication inventory.
- State-source matrix.
- Responsive behavior matrix.
- Baseline screenshot set.

### Phase B — Tokens and primitives

- [ ] Add semantic color, surface, typography, spacing, radius, elevation, motion, and z-index tokens.
- [ ] Consolidate Button, IconButton, Input, Select, SegmentedControl, and Tabs.
- [ ] Consolidate Tooltip, Popover, Modal, Drawer, Toast, and StatusIndicator.
- [ ] Add component-state tests and accessibility checks.
- [ ] Migrate no feature page until its required primitives are verified.

Gate:

- Primitive visual and interaction tests pass in dark theme and every retained theme.
- Focus, disabled, error, loading, and touch states are documented and tested.

### Phase C — Responsive app shell

- [ ] Implement the left/center/right desktop structure.
- [ ] Implement compact-desktop collapse behavior.
- [ ] Implement mutually exclusive touch drawers.
- [ ] Implement PWA safe-area and dynamic viewport handling.
- [ ] Preserve Composer and Terminal focus rules.

Gate:

- Layout tests and screenshot baselines pass at every required viewport.
- No primary region clips, overlaps, or becomes unreachable.

### Phase D — Critical workflows

Implementation order:

1. [ ] Connect Workspace modal.
2. [ ] Connection health.
3. [ ] Workspace tools shell.
4. [ ] Terminal.
5. [ ] Files and Git.
6. [ ] Session navigation.
7. [ ] Tool activity/intention.
8. [ ] Composer state presentation.

Gate after each workflow:

- Focused unit/component tests pass.
- Relevant browser workflow passes.
- Desktop plus applicable touch viewport screenshots pass.
- No unrelated feature is migrated in the same review unit.

### Phase E — Reliability and recovery

- [ ] Rapidly switch sessions within one workspace.
- [ ] Switch repeatedly between workspaces.
- [ ] Open and close tools drawers during active output.
- [ ] Suspend and resume the browser/PWA.
- [ ] Test offline, high latency, packet loss, transient disconnect, and reconnection.
- [ ] Confirm one physical socket per browser tab and logical workspace/session subscriptions.
- [ ] Confirm Files, Git, Terminal, Composer, and connection health recover consistently.

### Phase F — Final visual and accessibility pass

- [ ] Remove residual unapproved borders, radii, colors, and shadows.
- [ ] Normalize all icon sizes and labels.
- [ ] Verify typography and wrapping in English and Chinese.
- [ ] Verify keyboard-only navigation and screen-reader names.
- [ ] Verify reduced motion, zoom, and text scaling.
- [ ] Review empty/loading/offline/error states side by side for consistency.

## 8. Required test matrix

### 8.1 Viewports and environments

- [ ] Desktop 1440×900.
- [ ] Compact desktop 1024×768.
- [ ] iPad portrait browser.
- [ ] iPad landscape browser.
- [ ] iPad portrait standalone PWA.
- [ ] iPad landscape standalone PWA.
- [ ] iPhone portrait browser and standalone PWA.
- [ ] Representative Android phone browser and standalone PWA where supported.

### 8.2 Interaction coverage

- [ ] Pointer, touch, and keyboard navigation.
- [ ] Drawer open, close, scrim dismissal, Escape, and mutual exclusion.
- [ ] Modal OS/mode switching and command copy.
- [ ] Session switching without workspace reconnection.
- [ ] Files/Git data retention and recovery.
- [ ] Terminal printable input and control keys.
- [ ] Composer input during connection transitions.
- [ ] Tool intention present, generated fallback, running, success, and failure.
- [ ] Connection health initial, healthy, stale, degraded, disconnected, and recovered states.

### 8.3 Network scenarios

- [ ] Normal network.
- [ ] Slow response/high latency.
- [ ] Request timeout.
- [ ] Brief offline period.
- [ ] Long offline period followed by recovery.
- [ ] Host available while Executor is unavailable.
- [ ] Executor replacement/update while the Dashboard remains open.
- [ ] Browser background/suspend and foreground resume.

### 8.4 Visual regression scenarios

Capture at minimum:

- [ ] Main shell with navigation and tools closed/open.
- [ ] Every workspace-tool tab.
- [ ] Connect Workspace for each OS and mode.
- [ ] Connection health normal, degraded, and disconnected.
- [ ] Session selected/running/waiting/error combinations.
- [ ] Tool intention normal/fallback/error combinations.
- [ ] Empty/loading/offline/error states.
- [ ] Virtual keyboard visible on touch devices where automation supports it.

## 9. Quality gates and completion criteria

The redesign is complete only when all applicable items are true:

- [ ] Core pages use approved semantic tokens and shared primitives.
- [ ] Ordinary containers no longer use high-contrast white outlines.
- [ ] Files, Git, Terminal, and Inspector exist only in the unified workspace-tools location.
- [ ] Phone and iPad never render a compressed three-column layout.
- [ ] Touch drawers are mutually exclusive, dismiss correctly, and preserve state.
- [ ] Connect Workspace commands react to OS/mode changes and pass route/installer tests.
- [ ] Terminal accepts and executes real input on desktop, iPad, phone, and standalone PWA.
- [ ] Session switching does not recreate the workspace connection or corrupt runtime indicators.
- [ ] Connection health displays a reliable, fresh RTT and does not report a usable Executor as unresponsive.
- [ ] Tool intention is meaningful for all supported providers and historical fallback cases.
- [ ] Loading, empty, stale, offline, and error states are distinct and consistent.
- [ ] Screenshot regressions pass at all required viewports.
- [ ] Accessibility checks and keyboard/touch interaction tests pass.
- [ ] Dashboard unit/component tests, production build, and PWA build pass.
- [ ] Real browser plus real Executor end-to-end acceptance passes.
- [ ] Deployment is followed by production route, asset MIME, installer, connection, and Terminal smoke tests.

## 10. Commit and rollout plan

Keep implementation reviewable and avoid mixing behavior with broad styling:

1. Design tokens and primitive components.
2. Responsive app shell and drawer behavior.
3. Connect Workspace modal.
4. Connection health presentation and state mapping.
5. Unified workspace-tools shell.
6. Terminal focus/input reliability and UI.
7. Files/Git states and UI.
8. Session rows and runtime indicators.
9. Tool intention/activity and Composer states.
10. Cross-device regression tests and visual baselines.
11. Deployment configuration only if required by verified route/asset defects.

Rules:

- Each commit has focused tests.
- Mechanical component migration is separate from behavior fixes when practical.
- Unrelated user changes are preserved.
- No API keys, tokens, personal information, real domains, or personal filesystem paths enter commits or fixtures.
- No push, Executor stop/restart, deployment, or release cutover occurs without the corresponding requested action and passed gates.

## 11. Risks to track

- [ ] Large CSS/token migration causing visually subtle regressions outside primary pages.
- [ ] Drawer mounting/unmounting destroying Terminal instances or input listeners.
- [ ] Responsive breakpoints based only on width and not pointer/orientation/PWA mode.
- [ ] Connection status derived from selected-session state instead of workspace state.
- [ ] Screenshot tests masking interaction failures.
- [ ] Mock terminal tests passing while the real PTY transport remains broken.
- [ ] Installer UI passing locally while production `/install*` routes return 404 or incorrect MIME.
- [ ] Service-worker caches serving mixed Dashboard generations.
- [ ] Localization expanding labels beyond compact control assumptions.

## 12. Execution checklist summary

- [ ] Approve this SOT and resolve open design decisions.
- [ ] Complete audit and baseline artifacts.
- [ ] Implement and verify tokens/primitives.
- [ ] Implement and verify responsive shell.
- [ ] Migrate critical workflows one at a time.
- [ ] Run reliability/network recovery matrix.
- [ ] Run visual, accessibility, browser, touch, and PWA matrix.
- [ ] Run real Executor end-to-end acceptance.
- [ ] Deploy only after all release gates pass.
- [ ] Run production smoke acceptance and record remaining risks.
