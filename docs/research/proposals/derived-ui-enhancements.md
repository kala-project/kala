# Dashboard Derived UI Enhancements

This document defines the next dashboard polish pass under one hard rule:

> Fancy dashboard features must be derived views over existing durable runtime data. Kernel state, reducer events, effects, and wire protocol may change only for real runtime semantics, never for visualization fidelity.

The implementation must not add UI-only fields to `@agent-kernel/kernel` or `@agent-kernel/shared`. Missing historical data should degrade gracefully.

## Scope

Implement every enhancement below except LLM call lifecycle visualization. The current code already has several foundations: Inspector Trace/LLM/Tool tabs, `JsonBlock`, tool-call grouping, `SubAgentCard`, `NestedTranscript`, and `DiffPreview`. The work should extend those surfaces instead of introducing parallel views.

## 1. Message Assembler Proportions And Linking

Goal: make captured LLM request assembly understandable without storing source metadata in the kernel.

Derived data:
- `LlmCall.effect.messages`
- `LlmCall.effect.tools`
- `LlmCall.trace.request.body` when captured
- provider/model labels already present in the call

Design:
- Add an estimated composition bar to `Message Assembler` with sections: System, User, Assistant, Tool, Tool Registry, Attachments, Other.
- Keep estimates local to the dashboard. Use serialized byte counts rather than pretending to have exact tokenizer data.
- Selecting or hovering a segment should highlight the matching kernel message rows and API body section when a mapping can be inferred.
- Display readable source labels only: `System`, `Tool registry`, `Conversation history`, `Current turn`, `Attachments`.

Non-goals:
- No new `source` protocol field.
- No adapter-side annotations just for UI highlighting.
- No synthetic request body when trace is missing.

## 2. Tool Call Grouped Lifecycle Row

Goal: transcript rows should present one tool operation instead of two disconnected messages.

Derived data:
- Existing assistant `tool_call` content
- Existing tool `tool_result` content
- Existing pending approvals by `callId`
- Existing grouped-call helpers in `features/chat/grouping.ts`

Design:
- `ToolCallGroupBlock` remains the single transcript display for grouped calls.
- Add lifecycle badges derived from local data: `approval`, `running`, `succeeded`, `failed`, `orphaned`.
- Show request summary and result summary in one compact row, with expandable details below.
- Preserve `SubAgentCard` special handling for `agent` tool groups.

Non-goals:
- No `tool_started` or `tool_completed` events.
- No executor progress protocol.
- No mutation of stored messages.

## 3. JSON Reader Enhancements

Goal: all JSON-heavy surfaces should be easier to inspect.

Derived data:
- Any object already passed to `JsonBlock`

Design:
- Keep `JsonBlock` as the standard component.
- Add local search/filter text.
- Add compact value summary in the header: object keys, array length, string length.
- Add a sticky path/search status strip when searching.
- Keep copy-all and expand/collapse-all.

Non-goals:
- No server-side JSON preprocessing.
- No persisted expansion state in session logs.

## 4. Explorer Session UX

Goal: improve navigation density and affordances.

Derived data:
- `server:sessions`
- `server:executors`
- selected session id
- local search query

Design:
- Add Explorer search that filters workspaces/sessions locally.
- Add matched text highlighting in session/workspace labels.
- Improve active session rail and hover action transitions with CSS only.
- Keep online/offline status derived from executor snapshots.

Non-goals:
- No server search endpoint.
- No persisted explorer filter/expanded state.

## 5. Composer Command And Mention Polish

Goal: make `/` commands and `@` file mentions feel like a command surface while preserving message format.

Derived data:
- Local composer text/caret
- Existing slash command callbacks
- Existing `client:list_files` result

Design:
- Show icon, command, description, and disabled reason for slash commands.
- Add keyboard active-row hints.
- Highlight matching portions in `@` file results.
- Improve paste/attachment tray motion with CSS only.

Non-goals:
- No command registration protocol.
- No file mention schema changes.

## 6. Context Pressure Popover

Goal: explain context pressure and compact decisions.

Derived data:
- `state.usage.inputTokens`
- `config.contextLimit`
- selected model context window
- queued message count
- captured request/message estimates when available

Design:
- Keep the small footer meter.
- Add click-to-open local popover with usage, model window, pressure level, queued messages, and estimated contributors.
- Mark contributor numbers as estimates.

Non-goals:
- No token breakdown protocol.
- No kernel-maintained per-section accounting.

## 7. Sub-agent Nested Transcript / DAG

Goal: make existing sub-agent data more visible.

Derived data:
- Existing `SubAgentCard`, `NestedTranscript`, parent/child session fields, and parsed sub-agent envelopes.

Design:
- Keep inline `SubAgentCard` for agent tool calls.
- Add a compact parent/child relation summary in the Inspector Status view when parent data is present.
- Use existing history loading for nested transcript.

Non-goals:
- No new sub-agent DAG protocol.
- No graph index in host.

## 8. Diff / Patch Viewer Enhancements

Goal: make file-modifying tool calls more readable.

Derived data:
- Existing tool input/output
- Existing `DiffPreview` and local diff helpers

Design:
- Add file path/status/addition/deletion header when derivable.
- Keep raw fallback for unknown tool shapes.
- Add hunk-level collapse locally if diff data is available.

Non-goals:
- No structured diff protocol.
- No tool schema changes.

## 9. Modal / Drawer / Tab Motion System

Goal: unify motion without introducing runtime state.

Derived data:
- Local open/selected state and Radix data attributes

Design:
- Add shared CSS motion classes for dialog, drawer, tabs, and popovers.
- Respect `prefers-reduced-motion`.
- Keep durations short and consistent.

Non-goals:
- No animation state in core or protocol.
- No heavy animation library unless required.

## 10. Live Status Topology

Goal: show current runtime connectivity at a glance.

Derived data:
- dashboard socket status
- current workspace executor presence
- selected model/provider where already available
- `session.lastError`

Design:
- Add a compact topology row to Status: Dashboard -> Host -> Executor -> LLM.
- Status dots and tooltips are derived from existing state.

Non-goals:
- No heartbeat protocol.
- No provider health check endpoint.

## 11. Keyboard Command Layer

Goal: provide professional navigation shortcuts locally.

Derived data:
- current sessions list
- local callbacks
- loaded trace/LLM/tool call lists

Design:
- `Cmd/Ctrl+K` opens a dashboard-local command palette.
- Include commands for settings, new session, toggle inspector, session switch, and current-view jumps where data is loaded.
- Disabled commands show local reasons.

Non-goals:
- No host command registry.
- No command protocol.

## Acceptance Checklist

For every implementation PR:
- No kernel event/effect/state change for visualization.
- No shared protocol change for visualization.
- Feature degrades on old logs.
- UI state remains local or local preference only.
- Tests cover derived behavior and fallback behavior.

## Implementation Notes

Implemented features in this pass:
- Message Assembler now derives System/User/Assistant/Tool/Tool registry/Attachment/Other proportions locally from existing `call_llm` messages and tools. Selecting a segment highlights matching kernel message/tool rows without source annotations.
- Chat tool groups now derive lifecycle badges (`Needs approval`, `Running`, `Succeeded`, `Failed`) from existing tool calls, results, and pending approval maps.
- `JsonBlock` now has local summary and serialized-search status while staying the single JSON renderer.
- Explorer search filters built tree data locally and highlights matched labels/paths.
- Composer slash commands now carry icon, title, and description; `@` file results highlight matched path segments.
- Runtime context pressure opens a local popover based on existing usage/config/model/queue props.
- Status view shows sub-agent parent/child relation summary and live topology from existing socket/state/LLM-call data.
- Diff preview recognizes common file path fields, shows file status/count metadata, and lets unchanged gaps expand locally.
- Dialog/alert dialog motion uses shared CSS classes with `prefers-reduced-motion` support.
- Command palette is dashboard-local (`Ctrl/Cmd+K`) and executes existing UI callbacks only.

Quality techniques used:
- Treat dashboard polish as derived view models, never reducer/protocol state.
- Prefer explicit fallback labels (`not called yet`, `no socket`, `cwd not reported`) over synthetic runtime facts.
- Keep transient UI choices in component state only.
- Add targeted tests per surface so the no-protocol contract remains easy to preserve during later UI work.
