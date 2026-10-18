# Dashboard Advanced Debugger Features

This document defines the next debugger-oriented dashboard features. The goal is teaching-first observability: users should see how an agent run moves through reducer events, emitted effects, provider API calls, tool execution, and runtime state without turning the right sidebar into a raw log dump.

## Design Inputs

- `packages/dashboard/STYLE.md`: use surface luminance and soft `ring-border/30-60`, avoid hard panel borders, and keep dense debugger controls visually quiet.
- `docs/architecture/dashboard/debugger-design.md`: the right sidebar is a debugger, not a metrics dashboard. Dense state is exposed through compact rows and detail modals.
- `docs/architecture/dashboard/llm-message-assembly-debugger.md`: LLM inspection must preserve the distinction between kernel `call_llm` effects and captured provider HTTP request/response.
- Existing data sources: `timeline`, `state`, `config`, `llmTrace`, `stateFlow(timeline)`, and pure kernel replay through `foldWithTrace`.

## Library Decision

No broad graph editor dependency is required for the first version. `@xyflow/react` is useful for editable node graphs, but it adds a larger dependency surface for a static teaching diagram. Protocol flow is implemented with local React/CSS/SVG-style bars.

`@tanstack/react-virtual` is an acceptable future addition for very large trace logs. It is MIT licensed, has a small dependency chain (`@tanstack/virtual-core`), and solves one narrow problem. This implementation keeps the trace list local first because current tests and fixtures are small; the minimap gives navigation without introducing new supply-chain risk.

## Feature Workstreams

### 1. Replay Scrubber / Time Travel

Purpose: let a learner select cursor `#N` and inspect the reconstructed reducer state after that event.

UI: a compact scrubber above the trace list with the current cursor, event kind, status transition, and previous/next buttons. It does not replace the live session state; it creates a read-only replay lens.

Data: `foldWithTrace(createInitialState(...), timeline.map(e => e.event), config)` produces state snapshots and effects. When the persisted log header initial state is not available to the dashboard, the replay starts from `createInitialState({ sessionId, systemPrompt: config.systemPrompt })` and applies timeline events. CWD and approval changes are still derived from events.

Tests: verify cursor selection changes the displayed state and diff.

### 2. State Diff View

Purpose: show what changed at the selected reducer step without forcing users to compare JSON manually.

UI: a compact diff panel next to the scrubber. It lists changed paths such as `status`, `messages.length`, `pendingCalls.0.status`, `cwd`, and `usage.inputTokens`. Large object values are summarized, with the raw event still available in the detail modal.

Data: compare replay snapshot before and after the selected event through a stable JSON path walker.

Tests: unit-test primitive, array length, add/remove, and nested changes.

### 3. Protocol Flow Diagram

Purpose: teach the kernel protocol: inbound event -> reducer -> effects -> external target -> next inbound event.

UI: a separate trace mode named `Flow`. It shows rows as source, event, reducer, effects, and target lanes. Clicking a row opens the existing detail modal.

Data: timeline entries plus effect classification (`llm`, `executor`, `user`, `done`, `error`).

Tests: verify LLM/tool/approval lanes render from fixture events.

### 4. Trace Search + Query

Purpose: find the event that explains a behavior quickly.

UI: one compact search input in the trace toolbar. Query text supports plain substring plus scoped tokens: `kind:llm_response`, `effect:call_tool`, `seq:123`, `source:llm`, `text:cwd`.

Data: local query parser, no `eval`, no regex injection surface. Unknown tokens fall back to substring matching.

Tests: query parser and rendered filtering.

### 5. Fork Compare

Purpose: make fork lineage understandable by comparing the current run with its parent around the fork cursor.

UI: a trace mode named `Compare`. For sessions with `parentSessionId`, it loads parent history through existing `client:load_history`, then shows shared prefix, parent-only tail, and child tail counts plus the first divergence row. If no parent exists, it shows a compact empty state.

Data: existing host protocol already permits loading arbitrary session history. The current `useSession` hook ignores non-current `server:history`, so compare uses a local listener/request pair in the inspector.

Tests: socket-hook behavior can be covered with a small mock later; component tests cover the current-session comparison helper.

### 6. LLM Request Inspector Upgrade

Purpose: make the actual provider request/response obvious and remove ambiguity around `evidence` or kernel-only data.

UI: the LLM detail modal gets an API summary strip: provider, model, request body keys, response status, stream event count, and trace availability. The raw captured request and response remain in the API Call tab.

Data: `llmTrace.request.body`, `llmTrace.response`, model fallback from trace body or timeline model.

Tests: verify captured raw body is present and redacted URL remains redacted.

### 7. Teaching Mode

Purpose: expose short explanations only when requested, preserving compact default UI.

UI: a small toggle in the trace toolbar. When enabled, selected rows show one-line explanations for event source, reducer transition, and emitted effect targets.

Data: local descriptions keyed by event/effect kind.

Tests: toggling reveals explanatory text and leaves default compact mode quiet.

### 9. Timeline Minimap

Purpose: give shape to long traces and quick navigation without making cards larger.

UI: a thin vertical minimap beside the trace list. Each event is a colored tick by category. Clicking a tick selects that event; the row list remains the source of detail.

Data: timeline categories already computed by `eventCategories`.

Tests: render one tick per visible event and select via click.

### 10. Run Health Panel

Purpose: summarize debugger-relevant run conditions without token cost or money metrics.

UI: Status gets a compact health panel with context pressure, pending approval, last error, missing LLM trace count, failed tool count, and current run status.

Data: `state`, `config.contextLimit`, timeline errors, tool results, LLM trace availability.

Tests: verify missing trace and failed tool warnings from fixtures.

## Design Review

- Style: all new panels use `bg-card`, `bg-background/70`, `bg-muted/40-60`, `ring-border/*`, and avoid bare large-surface borders.
- Density: trace cards stay compact; selected/raw details stay in modals or small auxiliary panels.
- Teaching fit: default view stays operational, Teaching Mode adds explanations only on demand.
- Supply chain: no new runtime dependency is introduced in the first implementation.
- Protocol accuracy: API request/response data is labeled as captured provider trace only when `llmTrace` exists; otherwise the UI explicitly falls back to kernel effects.
