# Core Agent Invariants and Fault Model

**Status:** normative for the highest-strength hardening program
**Extends:** [`../kernel/spec.md`](../reference/kernel/spec.md)
**Deployment rule:** Dedicated and Private Cloud must satisfy the same core invariants.

## Authority map

| Concern | Sole authoritative source | Derived/read models that must not override it |
|---|---|---|
| Agent transition | Kernel `step(state,event,config)` | Dashboard labels, socket timing |
| Durable Session order | persisted event log sequence | arrival order of live/history socket messages |
| Current Tool lifecycle | `AgentState.pendingCalls` plus durable matching results | absence of a visible `tool_result` in a paged transcript |
| User follow-up queue | Host persisted message-queue snapshot | optimistic Dashboard queue |
| Current context size | Host `ContextUsageSnapshot` assembled from current model-visible messages | cumulative provider `state.usage` |
| Lifetime model usage | `AgentState.usage` / usage ledger | context indicator |
| Executor execution receipt | Host operation ledger + Executor receipt keyed by scoped operation ID | socket connection state alone |
| Organization authorization | Private Cloud control plane before Unit routing | RuntimeHost, browser-selected tenant IDs |
| Transcript history | authoritative history replay by event sequence | stale live cache conflicts |
| Browser identity | server-revocable browser Session | local storage/profile display |
| Restart plan | persisted restart attempt and durable Session state | pre-restart in-memory flags |

## System invariants

Kernel invariants I1–I8 remain mandatory. The following cross-component invariants add Host, Executor, Dashboard and Private Cloud requirements.

### S1 — Durable event uniqueness

For one Session, every newly persisted event has one unique integer sequence and sequences are strictly increasing by one. Concurrent dispatches cannot observe and commit the same prior cursor. Duplicate or regressing sequences in legacy logs are detected explicitly; they are never silently interpreted as valid ordering.

### S2 — Commit before broadcast

A state/event update is persisted successfully before `event:appended`, `state:changed`, queue updates or terminal notifications claim it happened. Persistence failure leaves the prior authoritative state and produces an actionable failure; it cannot broadcast an uncommitted transition.

### S3 — Serialized Session mutation

All state-changing operations for one Session join one serialization boundary, including user messages, Queue drain, Steer, Cancel, Approval, Tool results, Compact replacement, recovery and administrative rewrite. Immediate I/O cancellation may happen out of band, but its durable state transition is coalesced and cannot race the Session cursor.

### S4 — User message exactly once

An accepted `operationId` creates at most one durable queued item or one dispatched `user_message`. ACK loss, reconnect, browser retry and multiple devices may repeat the request but not the turn. The UI clears a submitted draft only after local ownership transfers to a durable/acknowledged operation and never clears unrelated edits.

### S5 — Queue durability and ordering

Every visible queued item is persisted before acknowledgement. Reorder, update, delete and drain are serialized per Session. Queue drain removes an item and dispatches it through a recoverable handoff: crash between removal and dispatch cannot lose the message, and retry cannot execute it twice.

### S6 — Steer boundary

Steer affects exactly one active turn: it requests a safe-boundary stop, preserves completed LLM/tool facts, and dispatches the persisted steer message next. It cannot strand `thinking`/`executing_tools`, cancel an unrelated later turn, surface as a stuck queue item or generate repeated Cancel events.

### S7 — Cancellation idempotency

Concurrent/repeated Cancel requests cause at most one non-no-op durable terminal transition for an active turn. Cancellation reaches active LLM, Tool and child agents promptly. Late results after cancellation are rejected or recorded as non-state-changing diagnostics; they cannot resume autonomous work.

### S8 — Tool call/result pairing

Within a Session and execution generation, `callId` is unique. Every pending call corresponds to one prior assistant tool call. A result settles a pending call at most once. Duplicate, unknown, late or cross-Workspace results cannot mutate Agent state. Terminal states have no live pending calls.

### S9 — Approval correctness

Only a currently pending `awaiting_approval` call accepts approve/reject. Decisions are idempotent. Partial decisions in parallel groups preserve other calls. Authorization is rechecked at decision time. Reject/cancel produces a model-visible failed result exactly once where continuation is valid.

### S10 — Executor scoped identity

Executor identity is bound to Organization/Workspace scope and cannot be selected by browser input. The Host dispatches only to a compatible, authorized Executor. Reconnect/retry uses scoped operation IDs and receipts; another Executor or tenant cannot claim an operation through ID collision.

### S11 — Compact atomicity

Compaction either commits one validated `messages_replaced` event or leaves messages unchanged. Replacement cannot split an active Tool call/result group or orphan `pendingCalls`. Summary quality/budget checks precede commit. Metadata and UI status describe the committed attempt, not cumulative Session usage.

### S12 — Forced context liveness

At hard pressure or provider overflow, the current autonomous turn must choose one bounded outcome: successful compact and continuation, deterministic emergency truncation and retry, or explicit actionable error. It cannot remain indefinitely in `thinking`, loop compaction without progress, or silently discard the newest user intent.

### S13 — Recovery exactly once

After graceful or crash restart, each interrupted Session resumes at most once according to durable state. `thinking` resumes an LLM continuation; dispatched Tools resume through idempotent receipts; approvals remain approvals; queued messages remain queued. Recovery does not append placeholder `[interrupted]` content unless it is an intentional user-visible terminal result.

### S14 — Sub-agent containment

A child has one parent/call identity and cannot outlive terminal parent cancellation unless explicitly detached by contract. Result propagation settles the parent call once. Depth/concurrency limits survive restart. Orphan children are detected and terminated or quarantined.

### S15 — Projection convergence

Given the same authoritative history and ready state, every Dashboard converges to the same transcript and live statuses. History replay supersedes conflicting cache entries. Streaming-to-persisted handoff preserves stable rendering identity without making array position the permanent identity of historical rows.

### S16 — Historical/live separation

A historical call lacking a visible result is not considered running unless its `callId` is in authoritative current pending state. Compact boundaries, pagination and old corrupt logs cannot create spinners, elapsed timers, approval controls or notifications for inactive work.

### S17 — Deployment-mode equivalence

Private Cloud wrapping may authenticate, authorize and route, but cannot fork Kernel/Queue/Compact/Tool semantics. The same event sequence and scoped Executor behavior produce equivalent Agent state in Dedicated and Private Cloud. A runtime profile hides only explicitly unsupported product areas, not core Workspace/File/Git/Shell/Executor capabilities.

### S18 — Tenant non-interference

Organization/Unit scope participates in every control-plane, Session, Workspace, Executor, artifact, token and operation lookup. Identical IDs in two tenants remain isolated across HTTP, polling, WebSocket, reconnect, logs and cleanup.

### S19 — Failure is bounded and explicit

Loading, Thinking, Tool execution, Compact and reconnect states have a real underlying operation and bounded recovery behavior. UI timers alone never invent failure. Authentication/authorization/offline/provider errors stop protected retries and surface an actionable state without destroying drafts.

### S20 — Sensitive-data minimization

Secrets never enter Dashboard payloads, Session logs, audit details, support bundles or artifacts unintentionally. Control-plane audit stores actor/action/resource/result/trace facts, not prompts, credentials or file bodies.

## Fault model

Every audit and acceptance lane must inject or model these faults at the named boundary.

| Boundary | Required faults | Required safe outcome |
|---|---|---|
| Browser ↔ Gateway | dropped ACK, duplicate POST/socket emit, expired Session, logout during retries, two devices | exactly-once operation, protected clients stop, draft preserved, explicit auth state |
| Gateway ↔ Runtime Unit | stale mapping, identical tenant IDs, reconnect to wrong Unit, Unit unavailable | fail closed, no cross-tenant fallback, actionable unavailable response |
| Host event store | concurrent append, delayed write, rejected write, torn final line, duplicate legacy seq, reload during append | no new duplicate seq, commit-before-broadcast, deterministic repair/quarantine |
| Queue store | crash before/after snapshot, concurrent edit/delete/drain, restart with pending item | no loss/duplication, stable ordering, durable visible state |
| LLM provider | timeout, abort, 429/5xx, malformed response, context overflow, short max-token response, missing usage | bounded retry/fallback, accurate state, no stuck Thinking |
| Compact summarizer | empty/invalid/oversized summary, no token progress, three failures, huge newest item | atomic no-op or bounded truncation; continuation/error per S12 |
| Host ↔ Executor | disconnect before ACK, after execution/before result, duplicate dispatch/result, late result after Cancel, capability change | receipt-based exactly-once effects and deterministic settlement |
| Tool process | timeout, ignored cancellation, large output, background process, partial filesystem mutation | bounded completion/cancel, output cap, honest result; no false retry of unsafe mutation |
| Approval | duplicate decisions, role revoked before click, decision after Cancel/restart | one authorized decision or explicit rejection; no execution after revocation |
| Restart | each Agent status, active LLM, each parallel Tool phase, Compact in flight, queue handoff, child agent | durable checkpoint and at-most-once recovery |
| Dashboard projection | live/history reorder, duplicate seq, reset, pagination, Compact boundary, stream commit, virtual unmount | convergence, stable rows, no ghost live state or flashing prior blocks |
| Storage/resources | disk full/slow, artifact unavailable, process memory pressure, 15 GiB long history | bounded degradation, diagnostic ID, no silent corruption |

## Required proofs

A graph node closes only with all applicable proofs:

1. A focused deterministic regression test for each fixed defect.
2. Property/model tests for sequence and state invariants.
3. Integration tests crossing the actual persistence/socket boundary.
4. Fault-injection seed and resulting integrity report.
5. Real-browser evidence for user-visible behavior.
6. Deployment-equivalence evidence for Dedicated and Private Cloud.
7. No new duplicate sequences in generated Session logs.
8. Cleanup evidence for all temporary tenant resources.

## Release blockers

Any of the following blocks Dedicated and Private Cloud release:

- duplicate/regressing sequence in a newly generated log;
- accepted message lost or executed more than once;
- terminal Session with active pending Tool/child work;
- cross-tenant read, route or execution;
- Compact/restart leaves an autonomous turn stuck without explicit error;
- cancellation permits a late unsafe result to continue the turn;
- Dashboard displays historical work as currently running;
- auth failure remains indefinite loading or background retry;
- secrets appear in client/audit/support evidence.
