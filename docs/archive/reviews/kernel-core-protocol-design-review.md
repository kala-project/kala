# Core State Machine and Protocol Design Review

**Status**: historical design review snapshot, 2026-07-07. Superseded for context compaction by `docs/host/context-compaction.md`.
**Scope**: kernel FSM, event/effect schema, JSONL event log, Host/Dashboard/Executor wire protocol, and the boundary between core state and peripheral side effects.

## 1. Review Lens

This review applies the core boundary principle from [`../architecture/overview.md`](../../architecture/overview.md) §4.4:

> Core mechanisms describe domain state and legal transitions. Peripheral mechanisms observe those transitions and perform environment-specific side effects.

The practical test is dependency direction. Kernel state and events may describe agent protocol facts; Host, Executor, Dashboard, hooks, adapters, and observers perform environment work. A feature should enter kernel state only if replay/fork/debugging of the agent protocol would be materially worse without it.

## 2. Executive Summary

The current architecture is fundamentally sound:

- The kernel remains a pure dispatch-table FSM: `step(state, event, config) -> { next, effects }`.
- Effects are declarative commands; Host performs IO and feeds results back as events.
- JSONL is the durable source of truth; replay/fork derive from event folding.
- Provider HTTP traces, streamed token deltas, notifications, sounds, background-shell operator controls, file pickers, and queue editing are outside kernel state.

The main risks are not conceptual, but operational:

- Spec drift has already appeared between docs and implementation (`ask` approval mode, `file_ref`, cache token fields, compact legality, old FSM state names). This is the highest-priority documentation/process issue.
- session-scope `memory` is the only current reducer-lifted tool exception. Historical `todowrite` calls remain ordinary protocol so Dashboard can derive the legacy Task List UI during replay; new sessions use Host `todo_graph`.
- The wire protocol surface is growing. `packages/shared/src/protocol.ts` must be treated as the implementation contract, with `docs/protocol/wire-protocol.md` updated in the same change.
- Host loop policy features such as preflight compaction and post-compaction loop guard are correctly outside the kernel, but should remain visibly host-owned and tested as host behavior.

## 3. Kernel FSM Review

### 3.1 Current Shape

The kernel has six statuses:

```text
idle -> thinking -> awaiting_approval -> executing_tools -> thinking -> done
                  \                                      /
                   -------- user_reject/tool_result ------
thinking -> error
cancel from active states -> done
```

The implementation uses `Record<AgentStatus, Partial<Record<AgentEvent['kind'], Handler>>>` in `packages/kernel/src/core.ts`. This is the right shape for this project: it mirrors the SPEC legality table, keeps illegal pairs as one no-op path, and avoids bringing a runtime statechart library into the pedagogical core.

### 3.2 Strengths

- **Replayable by construction**: cursor increments exactly once per `step`, including no-ops.
- **Forkable by construction**: `fork(initial, events, cursor, newEvents, config)` is a slice plus fold.
- **Deterministic effects**: effect order follows model output order, which matters for parallel tool calls and approval UI.
- **Host-owned IO**: LLM calls, tool dispatch, stream cancellation, compaction, hooks, and subagents stay outside the reducer.
- **Resting-state controls are clear**: `cwd_changed` applies only from `idle` / `done`; Host validates paths and rejects misleading successful UI flows.
- **Approval policy is protocol state**: persisting `approval_mode_changed` makes replay and fork semantics visible.

### 3.3 Weak Spots

- **Reducer-lifted tools are exceptions**: `memory { scope: 'session' }` makes tool input first-class `AgentState`. This should remain a short allowlist in `tool-lift.ts`. Future tools should default to opaque tool results or dashboard-derived views.
- **`ask` mode semantics must stay explicit**: current implementation forces approval for every tool in `ask`; this is useful and distinct from `auto`. Docs previously described it as an alias. That drift has been corrected.
- **Compaction is replay-visible but policy-free**: `messages_replaced` is a kernel event because replay must see the message replacement. Compaction policy, context pressure, summarizer request/response, and skipped/rejected attempts are host/runtime metadata concerns.
- **Context pressure is host state**: the host computes `ContextSnapshot`; the kernel does not carry `contextPressureLevel`.

### 3.4 FSM Review Rules

Before adding a state/event/effect field:

1. Does replay/fork need this fact to reconstruct protocol state?
2. Is it deterministic from prior state, event, and config?
3. Does it avoid browser, network, filesystem, time, random, provider, and UI concepts?
4. Can an illegal pair no-op safely while still advancing cursor?
5. Can the feature be implemented as Host/Dashboard observer state instead?

Only if the first four answers are yes, and the fifth is no, should kernel surface grow.

## 4. Event / Effect Schema Review

### 4.1 Events

Events are facts already observed by Host or Dashboard: user message, LLM response/error, approval choice, tool result, cancel, clear, compaction replacement, approval-mode change, cwd change.

Good properties:

- Event names describe facts, not transport actions.
- `llm_response` and `tool_result` are provider/executor independent.
- `clear` keeps session identity and workspace binding; it is a current-session reset, not session creation.
- `messages_replaced` carries only the deterministic replacement fact; teaching/debug metadata lives in runtime metadata or artifacts.

Risks:

- `event.kind` is now broader than the original v0.1 docs. Any external consumer should import shared/kernel types rather than hard-code an old union.
- `UserMessageEvent` allows both `text` and `content` at the type level. Handler currently prefers `content`; docs say exactly one should be present. Host/Dashboard should enforce this contract.

### 4.2 Effects

Effects remain appropriately small:

- `call_llm`: messages + tools.
- `call_tool`: call id, tool name/input, optional cwd.
- `request_approval`: approval UI data.
- `finish` / `emit_error`: terminal notifications.

The important design point is that effects contain no Host addresses, provider URLs, executor ids, retry policy, timeout policy, or UI rendering hints. `cwd` on `call_tool` is acceptable because it is agent protocol state that Executor needs to run the tool in the session context.

## 5. Host Loop Review

The Host loop is correctly the impure driver:

```text
incoming event -> step -> persist JSONL -> broadcast -> perform effects -> feed result events back
```

Healthy design choices:

- LLM adapter traces are attached to log entries as metadata.
- Stream deltas are UI-only and collapse into a final `llm_response` event.
- Cancel aborts in-flight LLM/tool work in Host/Executor while the reducer only changes state.
- Hooks run around tool dispatch as Host policy.
- `agent` and `skill` are Host-side tools. The parent kernel only sees a normal tool call/result.
- Preflight compaction and post-compaction repeated-tool guard are Host policy, not kernel transitions.

Watch points:

- Keep `messagesForLlmCall` as effect preparation. Do not move preflight compaction heuristics into reducer logic.
- Hook failures should remain tool-result facts, not hidden state mutation.
- Any future loop detection/circuit breaker should be host-side observer policy that emits ordinary events/results.

## 6. Wire Protocol Review

### 6.1 Topology

Two Socket.IO namespaces remain appropriate:

- `/dashboard`: user intent, session observation, operator control-plane RPCs.
- `/executor`: workspace daemon announcement, tool execution, filesystem/background-shell RPCs.

Routing by stable `workspaceId` is the right correction over display labels. `workspaceName` is UI text only.

### 6.2 Message Categories

The protocol now has five categories:

- **Kernel event injection**: `client:user_message`, approval/reject, cancel, clear, compact, approval mode, cwd.
- **Session observation**: `session:ready`, `state:changed`, `event:appended`, `server:history`.
- **Host control plane**: sessions, models/settings, queue edits, fork, rename/delete.
- **Executor RPC**: `tool:call`, `tool:cancel`, `fs:*`, background-shell RPCs.
- **Dashboard-only observers**: token deltas, sub-agent lifecycle, desktop/toast notifications derived client-side.

This categorization should appear in future reviews. New messages should declare which category they belong to.

### 6.3 Strengths

- The protocol keeps kernel events separate from operator conveniences. For example, queued-message reorder/edit/delete does not emit kernel events until delivery.
- File picker and overflow reads are workspace RPCs, not hidden tool calls and not reducer state.
- Background-shell operator controls are separate from the agent-facing tools. The agent still sees `bash`, `bash_output`, and `kill_shell`; the dashboard can observe/control without prompting the LLM.
- Sub-agent live events are dashboard observability; the parent session still receives a normal `tool_result` envelope.

### 6.4 Risks

- Wire docs and `packages/shared/src/protocol.ts` can drift. The shared type file says: "Any change here MUST also update docs/protocol/wire-protocol.md". That rule should be enforced in review.
- `session:ready` can be ephemeral for unknown sessions, while `client:user_message` refuses unknown sessions. This is reasonable UX, but must stay documented because it prevents accidental unbound sessions.
- Delete/fork parent edge cases need robust UI handling. If a parent session was deleted, `go to parent` should show a clear unavailable state instead of assuming load success.
- ACK and push alternatives (`tool:call` ACK vs `executor:tool_result`) are flexible but require dedup by `callId`. Current registry does this by pending map; keep callId uniqueness strict.

## 7. Event Log Review

The event log design is strong:

- Header captures config and initial state.
- Event lines store applied event and emitted effects for audit/debugging.
- Metadata entries do not advance cursor.
- Snapshots are optional accelerators, not authoritative.
- LLM trace/model are metadata, not kernel state.

Review requirements:

- Effects stored in the log should be considered a drift detector. Replay can recompute effects; if they differ, implementation or historical compatibility changed.
- Header `initialState` must include every state field added to `AgentState`, even if defaulted.
- Recovery fix-ups must append real events, never mutate old lines.

## 8. Documentation Drift Found And Corrected

This review corrected the following drift:

- `docs/architecture/adr/0010-fsm-dispatch-table.md` used old state names (`awaiting_llm`, `calling_tool`, `cancelled`). It now names the current six statuses.
- `docs/reference/kernel/spec.md` described `ImageSource.kind: 'file'`; implementation uses `file_ref`.
- `docs/reference/kernel/spec.md` omitted `ThinkingContent`, cache token usage fields, `thinkingBudget`, and `preflight` compaction trigger.
- `docs/reference/kernel/spec.md` described `ask` as equivalent to `auto`; implementation and tests define `ask` as approval for every tool.
- Older `docs/reference/kernel/spec.md` revisions described compaction and cwd events as legal in broader status sets than the reducer table allowed.
- `docs/protocol/wire-protocol.md` was missing newer queue-edit and file/overflow control-plane messages, plus `client:fork.seedMessage`.
- `docs/protocol/wire-protocol.md` had one stale statement implying executor routing by `workspaceName`; routing is by `workspaceId`.

## 9. Improvement Backlog

### P0: Keep Specs Synchronized

- Treat `docs/reference/kernel/spec.md` and `packages/kernel/src/types.ts` as a pair.
- Treat `docs/protocol/wire-protocol.md` and `packages/shared/src/protocol.ts` as a pair.
- Add a lightweight CI check or review checklist that fails when shared/kernel protocol files change without corresponding docs changes.

### P1: Constrain Reducer-Lifted Tool State

- Keep the allowlist in `tool-lift.ts` explicit and small. Today it is session-scope memory only.
- Add a short ADR or SPEC subsection: "Reducer-lifted tools are exceptions".
- Require tests for malformed input, failed tool result, and non-session scope for every lifted tool.

### P1: Protocol Category Labels

- Add comments in `packages/shared/src/protocol.ts` grouping messages into kernel injection, observation, host control plane, executor RPC, and dashboard-only observer categories.
- In docs, require every new message to state whether it produces a kernel event.

### P2: State Machine Visualization

- Generate a simple diagram from the `transitions` table or keep a checked-in Mermaid/text diagram matching SPEC §3.
- Use this in the teaching debugger so users can map trace rows to legal transition cells.

### P2: Stronger Runtime Validation At Boundaries

- Consider zod/valibot or hand-written validators at Host socket boundaries if protocol misuse becomes common. Do not add validation inside the kernel.
- Validate that `client:user_message` sends either structured content or plain text according to the contract.

### P2: Edge-Case UX

- Parent session deleted: `go to parent` should resolve to an unavailable modal/state.
- Workspace offline during cwd selection or file read: errors should be scoped and non-fatal.
- Executor reconnect during pending call: redispatch behavior should remain covered by tests.

## 10. Final Assessment

The core design should stay as-is: pure reducer, event/effect boundary, JSONL replay, Host as IO driver, Executor as workspace RPC daemon, Dashboard as observer/control surface.

The next quality step is discipline, not a new architecture: keep specs synchronized, resist expanding `AgentState` for observer-only features, and keep Host/Dashboard side effects in explicit boundary modules.
