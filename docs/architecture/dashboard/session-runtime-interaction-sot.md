# Session Runtime Interaction and Preview Contract

**Status:** normative Dashboard source of truth
**Scope:** active-session streaming/tool execution, Explorer interaction, Session hover preview, Connection Status, Session Status, overlays, browser acceptance
**Authority:** this document specializes `docs/standards/engineering/principles.md`, `docs/standards/release-quality/testing.md`, and `docs/development/testing/critical-user-action-matrix.md` for these Dashboard surfaces
**Last reviewed:** 2026-08-09

## 1. Purpose

A running Agent must never make product-shell controls feel disabled. Streaming text, tool-state transitions, transcript measurement, and preview updates are high-frequency data-plane work. Session selection, Explorer hover, Connection Status, and toolbar controls are control-plane interactions and must remain responsive while that work continues.

This document is the single source of truth for the affected behavior. Older planning notes and implementation comments are descriptive only and do not override it.

## 2. Audit of the current implementation

### 2.1 Confirmed existing protections

The Explorer is not wholly rebuilt for every raw `thinking`/`executing_tools` transition:

- `sameSessionListForExplorer` compares running statuses coarsely.
- `coarseStatusForIndicator` collapses rapid running-state transitions.
- `SessionRuntimeStore` lets one Session row subscribe to its own volatile status.
- `Explorer` is memoized with a purpose-built comparator.

These mechanisms must remain. The defect must not be “fixed” by replacing them with a broader state framework.

### 2.2 Confirmed remaining violations

1. `SessionHoverPreview` mounts a second full `ChatPanel` and calls `visibleTranscript` before taking a 12-item tail. A tail limit therefore does not bound preprocessing or component cost.
2. `SessionPreviewStore` publishes every `session:token_delta`. A hovered running Session can rebuild its preview once per token event.
3. `ConnectionStatus` is embedded in the frequently rendering App function and has no memoized scalar boundary. Inline callback props defeat ordinary memoization.
4. The toolbar status reduces `thinking` and `executing_tools` to a generic loading spinner. Sidebar and toolbar use the same tiny icon despite different information density.
5. Existing browser acceptance covers streaming scroll, but not shell-control interaction during token/tool floods.

### 2.3 Rejected or unproven diagnoses

- Running state does not explicitly set Session rows or Connection Status to `disabled`.
- No running-state overlay was found in code.
- A reproduced full-screen Radix overlay came from a pending Executor pairing dialog. It correctly blocks background input while open and is not evidence of a running-session overlay leak.
- Adding arbitrary `z-index` values is not an accepted fix.

## 3. Invariants

### 3.1 Control-plane responsiveness

While any Session is `thinking`, `executing_tools`, or `awaiting_approval`:

- an unselected Session row must paint hover feedback immediately;
- its preview must appear within 500 ms including the intentional hover delay;
- clicking a Session row must commit selection within 150 ms of the click task running;
- Connection Status must open within 100 ms;
- controls must not remount merely because a token or tool event arrived;
- no transparent element may intercept their hit targets unless a visible modal dialog is open.

### 3.2 Preview cost boundary

Session Hover Preview is a summary surface, not a second Session client.

It must:

- render a bounded recent projection directly;
- never mount `ChatPanel`, `VirtualTranscript`, Mermaid, KaTeX, Shiki, Monaco, or nested Session previews;
- omit fenced diagrams/code through a labeled placeholder;
- truncate large text and tool output before rendering;
- coalesce live token updates to at most one publication per animation frame and no more than ten publications per second;
- subscribe only while the delayed preview is visible;
- preserve cached-first paint and live/stale freshness labels.

### 3.3 Stable hover and selection state

- Row activation and preview visibility are separate state transitions.
- `mousedown`/`pointerdown` must not tear down or recreate the Arborist row.
- Selecting a row closes the preview only after selection commits.
- Leaving the row for the preview uses a short grace period; returning cancels closure.
- Preview positioning derives from a current anchor element/rect and stays inside the viewport.

### 3.4 Connection Status boundary

Connection Status must be memoized against scalar connection inputs. Callback identity alone must not trigger rendering. Its popover owns its local open state and remains open through token and tool events. The popover must use a portal/collision-safe position and must not alter Session subscription state.

### 3.5 Session Status semantics

Sidebar and toolbar have different presentations but one status vocabulary:

| Runtime state | Sidebar | Toolbar |
|---|---|---|
| `thinking` | blue-violet activity dot | `Thinking` pill |
| `executing_tools` | violet tool/activity glyph | `Running tools` pill |
| `awaiting_approval` | amber alert | `Approval needed` pill |
| `error` | rose alert | `Error` pill |
| `done` | subdued emerald dot | `Completed` pill |
| `idle` | neutral outline dot | `Ready` pill |
| hydration/loading | neutral spinner | `Loading session` pill |

Requirements:

- one border and one background layer only;
- no card-inside-card treatment;
- no decorative outer ring around the sidebar icon;
- animation is subtle and honors reduced motion;
- text is visible in the toolbar, not hidden behind a title attribute;
- status remains accessible through `aria-label`.

## 4. Architecture

### 4.1 Stable shell

Keep the existing `SessionRuntimeStore` and Explorer comparator. Add narrow memo boundaries instead of introducing a new global store:

- `ConnectionStatus` compares socket and scalar diagnostics, with event handlers read through stable refs or stable callbacks.
- `WorkbenchToolbar` receives a stable status descriptor and stable handlers.
- transcript high-frequency state stays below the shell where practical.

### 4.2 Lightweight preview projection

`SessionHoverPreview` receives the cached/live Session view but produces `SessionPreviewItem[]` with a pure bounded projector. The projector scans only a bounded tail of messages/timeline and returns plain summary records. Rendering uses dedicated lightweight rows.

Complex assistant content becomes:

```text
Diagram · omitted from Session preview
Code block · omitted from Session preview
```

Tool records show tool name, intent when present, status, and a bounded target/result line.

### 4.3 Live update coalescing

`SessionPreviewStore` accumulates token deltas immediately in its runtime but schedules publication. At most one timer/animation-frame callback exists per Session. Terminal events flush pending text before publishing authoritative state. Unwatch and disconnect cancel scheduled publication.


## User-message anchor navigation

The transcript treats each User message as the start of a conversational chapter.
When at least two User messages exist, compact previous/next controls at the left of
the chat jump to the adjacent User-message anchor, not by a fixed pixel/page offset.
The current viewport anchor determines the starting point; the target User message
is placed near the top so the reader can continue downward through the complete
Assistant/Tool turn. The first/last direction is disabled, and navigation changes no
Session state or persisted event.

## 5. Overlay rules

- Visible modal dialogs may intentionally block background input.
- Non-modal previews and status popovers must not set `body { pointer-events: none }`.
- Every modal overlay must unmount when its open state closes.
- Browser tests inspect `elementFromPoint` for Session rows and Connection Status with no modal open.
- Tests must distinguish a legitimate pairing/confirmation dialog from an invisible stale overlay.

## 6. Progressive implementation and regression gates

1. Freeze current Explorer comparator/runtime-store tests.
2. Add pure preview projector tests before replacing `ChatPanel` in the preview.
3. Add preview-store coalescing tests before enabling live throttling.
4. Add memo-boundary render-count tests for Connection Status and toolbar.
5. Replace status visuals only after semantic tests pass.
6. Run focused tests after each slice; do not batch all UI changes before verification.
7. Run a production browser stress scenario with a real Host, Executor, persisted Session, token stream, and real tool execution.
8. Build release assets only after browser evidence passes.
9. Deploy through the external supervisor contract below; verify completed cutover state, new PID, bundle digest, HTTP 200, and Session continuation.

### 6.1 Self-hosted deployment control

When the Agent Session performing a deployment is itself managed by the Host being replaced, Host-global checkpoint drain creates a control-loop dependency: the deploy command waits for its own Session to become safe while the Host rejects messages for every other Session. This is prohibited.

Required deployment behavior:

- release assembly and `deploy/current` symlink switching are performed by a process outside the target Host;
- preflight queries Session safety without entering global drain;
- if any Session is actively executing an LLM/tool turn, deployment remains staged and reports `waiting`, but the Host continues accepting messages for unrelated Sessions;
- cutover starts only when all Sessions are naturally safe, or after an explicit operator-approved bounded force policy;
- the external supervisor performs the process restart and post-start health/digest checks;
- the deploying Session is never required to poll a Host endpoint whose drain state blocks that same Session;
- global checkpoint restart remains valid for operator-driven maintenance from an independent control process, not for self-hosted in-Session deployment.

Dedicated now uses `deploy:dedicated` and the external Deploy Supervisor request/receipt protocol. Portable retains the separate single-service finalizer. Dashboard-only changes use `deploy:dashboard` and do not wait for Runtime quiescence. Do not poll a deployment from the same Tool call whose durable result is the origin barrier.

## 7. Required automated evidence

### Component and store tests

- running-status equivalence does not rerender the full Explorer;
- only the changed Session row receives runtime-store notification;
- hover preview contains no `ChatPanel` or virtual transcript;
- Mermaid/code fences produce omission rows;
- preview token events are coalesced and terminal events flush;
- Session click remains single-click with a preview open;
- Connection Status remains open across simulated token/tool updates;
- every status maps to the required semantic label and visual tone;
- no non-modal preview creates a full-screen pointer-event blocker.

### Browser stress acceptance

During at least 20 seconds of active streaming/tool execution:

1. hover at least three unselected Session rows;
2. open and close Session Preview;
3. switch away and back to the running Session;
4. open Connection Status and exercise Resync;
5. verify Session Status for thinking and tool execution;
6. inspect hit targets with `elementFromPoint`;
7. record interaction latency, console errors, failed requests, and screenshots;
8. verify reduced-motion behavior and a desktop viewport; mobile must keep controls operable but hover preview is not required.

Release fails if any control requires a second click, any preview mounts heavyweight renderers, an invisible overlay intercepts input, or latency exceeds the contract repeatedly.

## 8. Code ownership

- Explorer row interaction/status: `packages/dashboard/src/features/explorer/Explorer.tsx`
- per-row volatile state: `packages/dashboard/src/features/explorer/session-runtime-store.ts`
- preview lifecycle/rendering: `packages/dashboard/src/features/explorer/SessionHoverPreview.tsx`
- preview live projection: `packages/dashboard/src/features/explorer/session-preview-store.ts`
- shell/connection/toolbar composition: `packages/dashboard/src/app.tsx`
- browser evidence: `scripts/dashboard/`
