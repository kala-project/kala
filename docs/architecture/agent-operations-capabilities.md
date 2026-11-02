# Agent Operations Capabilities

**Status:** normative source of truth
**Scope:** Dashboard, Host, Kernel, Executor, Shared Protocol
**Supersedes:** the statements in `docs/host/sub-agent-design.md` that background Agent tasks are out of scope or that non-blocking task control is intentionally skipped
**Related:** `core-agent-invariants-and-fault-model.md`, `graceful-restart-and-deployment.md`, `event-log.md`, `sub-agent-design.md`

## 1. Product objective

Agent RunLab must support four operational capabilities without creating parallel sources of truth:

1. searchable Session transcripts;
2. progressive disclosure of a versioned Tool catalog;
3. honest, attributable network-policy audit evidence;
4. a unified console for durable child-Agent tasks.

These capabilities must preserve replay, compaction, fork, approval, cancellation, tenant isolation and planned-restart semantics. They must behave equivalently in Dedicated and Private Cloud deployments whenever the selected runtime profile enables them.

## 2. Authority map

| Concern | Authoritative source | Derived state |
|---|---|---|
| Session transcript | Session JSONL ordered by `seq` | browser search index and snippets |
| Full Tool catalog | Session header `AgentConfig.tools` plus its catalog identity | stable provider Tool array |
| Discovered Tools | durable Session metadata, intersected with the selected catalog | discovery results |
| Network policy | validated versioned policy snapshot | normalized target decision |
| Network audit | persisted Host audit entry accepted from a trusted execution location | Dashboard aggregation |
| Child Agent task identity and state | child Session JSONL, parent/call lineage and current Agent state | `AgentTaskSummary` |
| Task controls | serialized Session mutation and idempotent operation receipt | optimistic Dashboard state |

No browser cache, process-local map, Tool result envelope or audit UI may override these authorities.

## 3. Transcript search

### 3.1 Scope

The first release searches the fully loaded active Session in the browser. It does not claim cross-Session or server-side full-text search. It requires no wire-protocol change.

Searchable categories are:

- `user` — durable and optimistic user text;
- `assistant` — assistant visible text;
- `thinking` — model reasoning text when present and authorized for display;
- `tools` — Tool name, natural-language intent, stable input serialization and Tool result text;
- `compaction` — visible compaction boundaries and summaries.

Images contribute only safe textual metadata such as filename or alt text. Binary bodies, hidden secrets and redacted fields are never indexed.

### 3.2 Identity and indexing

A match is anchored by stable transcript identity, not DOM position:

- durable item: event `seq` plus content-part ordinal;
- optimistic item: pending operation/message ID;
- live assistant draft: `streaming-assistant` plus content-part ordinal.

The index has two layers:

1. immutable or append-only durable base;
2. replaceable live tail.

Strict tail append indexes only new items. Authoritative history replacement, compaction or reorder rebuilds the base. Empty queries perform no scan.

### 3.3 Navigation

`Cmd/Ctrl+F` opens Session search only when the Agent transcript is active. `Enter` selects next, `Shift+Enter` previous, and `Escape` closes and restores focus. Navigation wraps.

A selected match maps to the rendered Virtuoso item. Searching historical content explicitly unpins auto-follow. Closing search does not repin. Repeated matches in one rendered Tool group must still trigger navigation through a separate navigation token.

The UI exposes query, category filters, `current / total`, no-result state and accessible live announcements. A folded Tool group may highlight the group and show a snippet/count; it must not claim hidden text is visibly highlighted.

## 4. Progressive Tool disclosure

### 4.1 Catalog and visible set

`AgentConfig.tools` remains the complete, frozen, replayable Session catalog. A canonical hash over stable ordered Tool definitions is its `catalogRevision`.

Each LLM request receives:

$$
T_{visible}=T_{selected}
$$

Provider adapters receive the entire selected catalog in its original order, including discovery and skill Tools. Discovery, latest-message network intent, activation, and non-tool settings never change provider Tool membership, descriptions or schemas. The required `_intent` schema augmentation is deterministic and idempotent.

Runtime refresh updates matching static definitions in place without expanding a Session's explicit selection or dropping its workspace MCP descriptors. Persisted selections and prompts survive restart; delegated Tool locks remain restrictive, and DAG Sessions retain their planner selection.

### 4.2 Catalog operations

`tool_search` is a Host-local, read-only, no-approval Tool. It searches name, purpose, tags, Toolset and execution location and returns bounded summaries. It does not return every JSON schema.

`tool_describe` is a Host-local, read-only, no-approval Tool. It returns full schema and version identity for explicitly named Tools and may activate them.

Activation is durable and catalog-bound. Before the next LLM effect begins, the Session JSONL records a `runtime_metadata` entry with `action: 'tools_activated'` and payload `{ catalogRevision, names }`. This is Host policy state, not model conversation state, so it does not become a Kernel event or enter model-visible messages.

Session-log replay restores available activated names even when catalog identity changes; removed names are excluded. Names outside the locked catalog are rejected. Activation changes discovery results, not subsequent provider Tools. An LLM response may invoke only Tools in that exact request.

### 4.3 Compatibility

Existing Session logs without disclosure state use `legacy_full`. Both configured modes now send the stable selected catalog; the mode and activation metadata remain compatible with existing logs. Catalog revisions hash canonical actual descriptions and augmented input schemas, including their order, in addition to declared identity fields. A catalog revision mismatch never silently substitutes schemas:

- historical schema remains the validation authority;
- current implementation must satisfy compatible version and execution identity;
- missing or major-incompatible implementations are unavailable;
- the failure is observable and actionable.

Executor announce must report actual implementation version instead of a universal synthetic version. Runtime compatibility checks are introduced without changing historical logs.

OpenAI and Anthropic both give an explicit system prompt precedence over transcript system messages. Ordinary requests use the same prompt with one idempotent `_intent` instruction augmentation, not duplicate or provider-dependent instructions. Explicit user prompt settings updates remain durable and synchronized; delegated instructions are not overwritten with root defaults. Skill discovery may return newly authored skills without changing this prompt or the provider Tool array.

### 4.4 Observability

Each LLM request records:

- catalog revision and total Tool count;
- visible Tool names/count;
- active on-demand count;
- full-catalog and visible-schema token estimate;
- estimated token savings.

These metrics are diagnostics and never mutate Agent behavior.

## 5. Network policy audit

### 5.1 Evidence vocabulary

Every event states evidence and enforcement level:

- `declared` — target extracted and evaluated before a controlled request;
- `application_observed` — controlled HTTP transport began, redirected, responded or failed;
- `proxy_enforced` — a future mandatory proxy observed the request;
- `os_enforced` — a future OS isolation layer proved bypass prevention;
- `unobserved` — no trustworthy network observation exists.

The first release implements application enforcement for built-in HTTP Tools only. Shell, background shell and interactive terminal are explicitly `unobserved`; command-string heuristics are not enforcement evidence.

### 5.2 Policy

A validated policy snapshot has stable `policyId`, `revision`, default action and ordered rules over:

- Tool name;
- `host` or `executor` execution location;
- HTTP/HTTPS scheme;
- normalized hostname pattern;
- effective port.

Targets are normalized before matching. Wildcards match DNS label boundaries, not arbitrary suffixes. Unsupported schemes and policy/hash mismatches fail closed.

Every redirect and auxiliary request is separately evaluated. `deny` occurs before invoking transport. `ask` is fail-closed in this release unless a separately persisted target-bound network grant exists; ordinary Tool approval is not a network grant.

### 5.3 Events

Two event families are persisted in the Host audit log:

- `network.policy_decision` — decision ID, policy identity, action, matched rule, normalized target, Tool/call/Session, execution location and `declared/application` evidence;
- `network.request_observed` — decision ID and `started`, `redirect`, `response` or `failed` phase with safe status/error metadata.

Query, fragment, credentials, cookies, headers and bodies are omitted. Path storage is disabled by default.

Executor-originated events carry stable event IDs and are acknowledged idempotently. The Host verifies the connected Executor, workspace, Session and active call association before accepting attribution. Strict audit mode blocks a controlled request if its required decision event cannot be persisted.

### 5.4 Coverage UI

The Dashboard displays target, decision, policy revision/rule, Host or Executor origin, and evidence badge. It distinguishes “allowed intent” from “request observed.” Shell surfaces a fixed coverage notice that network activity is neither observed nor enforced in application mode.

The JSONL audit is an operator log, not tamper-proof evidence against the machine administrator.

## 6. Agent task console

### 6.1 Identity and projection

A child Agent task is a child Session. `taskId === childSessionId`. No `AgentTask` database or duplicate transcript is introduced.

`AgentTaskSummary` is projected from:

- child Session header and metadata;
- child current state and timestamps;
- parent Session Tool call/result for terminal semantics and agent type;
- latest durable Todo Graph snapshot for progress;
- process runtime only for currently available controls.

The summary includes label, lineage, workspace, agent type, state, timestamps, graph summary, recoverability and capabilities (`open`, `rename`, `stop`, `resume`).

### 6.2 States

Public states are:

- `queued`
- `running`
- `waiting_approval`
- `stopping`
- `stopped`
- `completed`
- `failed`
- `interrupted`
- `recoverable`

Projection rules are deterministic and tested. Process-local `activeSubAgents` can refine `stop` availability but cannot be the only evidence that a non-terminal child exists.

### 6.3 Query and control protocol

The Host exposes authoritative list/get snapshots and one control command:

```typescript
type ClientControlAgentTask = {
  operationId: string
  sessionId: string
  action: 'stop' | 'resume' | 'rename'
  label?: string
}
```

Results distinguish `accepted`, `already_terminal`, `not_recoverable`, `conflict` and `not_found` and return the updated summary.

- `open` selects the existing child Session and does not mutate it;
- `rename` reuses durable Session metadata;
- `stop` dispatches the standard child Session cancellation, clears pending queue work and reconciles the parent call; it works after Host restart even if process-local maps are empty;
- `resume` continues only a provably recoverable durable state and never creates another child;
- retrying a completed task is a future separate action that must create a new child with explicit lineage.

All controls are authorized, idempotent by operation ID, serialized with Session mutation and audited.

### 6.4 Background semantics

The console manages all child Agent Sessions, including children whose parent currently waits synchronously. “Background” describes operator control and visibility independent of the parent view; it does not falsely claim every existing parent Tool call is detached.

A true non-blocking spawn mode may be added only when parent completion/result handoff is durable and exactly once. Until then, the UI labels synchronous children accurately. This release must not create a detached child whose result has no durable parent settlement path.

Background Shells are associated resources, not Agent tasks. They remain process-owned and are labelled non-recoverable after Executor loss.

### 6.5 UI

The Dashboard provides an Agent Tasks console reachable from the Agent workspace. It lists status, label/agent type, parent, workspace, elapsed time, Todo Graph progress and blocking/recovery reason. Actions are Open, Rename, Stop and conditional Resume. Reconnect replaces optimistic state with the Host snapshot. Existing SubAgentCard and Explorer reuse the same state mapper.

## 7. Security and tenancy

- Every query and control is scoped to the authenticated organization/runtime unit and authorized Session.
- Browser-supplied workspace, parent or execution identity is never trusted.
- Search indexes only content the active Dashboard already received.
- Tool disclosure cannot expand a sub-agent allowlist.
- Network audit never stores secrets or treats Tool approval as destination approval.
- Agent controls reauthorize at execution time and cannot cross tenant boundaries.

## 8. Required acceptance matrix

### Transcript search

- extraction and filtering for every content type;
- Unicode/case behavior, multiple spans and wrap navigation;
- durable anchors across append, reset, optimistic reconciliation and streaming handoff;
- folded Tool-group mapping and repeated navigation token;
- unpin behavior and virtualized off-screen jump;
- keyboard, focus, ARIA and 10k-item performance fixture.

### Tool disclosure

- canonical catalog revision and stable ordering;
- search ranking/bounds and describe validation;
- activation event durability and replay;
- exact request visible-set enforcement;
- legacy-full compatibility and new-session progressive mode;
- sub-agent allowlist intersection;
- catalog drift and implementation-version failure;
- full/visible token metrics.

### Network audit

- URL/IDNA/IP/port normalization and wildcard boundaries;
- allow/deny/ask, policy revision mismatch and redaction;
- local HTTP integration proving deny sends zero requests;
- redirect re-evaluation;
- Host and Executor controlled Tool parity;
- idempotent Executor audit ingest and attribution rejection;
- strict audit write failure blocks request;
- UI evidence badges and shell `unobserved` notice.

### Agent task console

- deterministic projector for active, approval, completed, failed, cancelled and recoverable states;
- list/get and operation schemas;
- stop after process restart with an empty active map;
- idempotent stop/rename/resume and authorization;
- no duplicate child or parent Tool result during recovery;
- Todo Graph summary;
- Dashboard open/rename/stop/resume, reconnect reconciliation, keyboard and touch accessibility.

## 9. Release gates

Before deployment:

1. focused tests for all four areas pass;
2. Shared, Kernel, Host, Executor and Dashboard builds pass;
3. protocol snapshots are intentionally updated;
4. browser acceptance covers Search and Agent Tasks;
5. local-only HTTP tests prove network deny and redirect behavior without public network access;
6. release assets build and verify;
7. `git diff --check` passes;
8. no secret, credential, private endpoint or personal domain is introduced.

LXD deployment occurs exactly once, after all gates. It uses `pnpm run deploy:remote -- --lxd <container> --skip-build` and the external transactional finalizer. The origin Tool call ends after `accepted`; completion is verified in a later turn by transaction phase, target hash, PID change, HTTP readiness, Executor reconnection, Session cursor monotonicity and no new structured interrupted response.
