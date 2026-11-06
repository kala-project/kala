# Multi-Agent Message Board & Next-Turn Child Messages (SoT)

**Status**: Merged into main; **not released to production**. `agent_board` stores topic revisions and advisory file claims atomically in PostgreSQL or SQLite (including Portable's SQLite sidecar). PostgreSQL schema 17 stores the ordered child-command inbox and per-message budgets; schema 18 adds commit-ordered initial-child completion fanout. Parent-owner-fenced submissions and child-owner-fenced claims permit cross-replica creation, placement, fan-out and next-turn follow-ups; an unconfirmed turn blocks later messages rather than replaying effects. The dashboard reads queued/processing/UNKNOWN from the durable inbox; processing requires a live matching child owner, while UNKNOWN never implies completion. Parent `client:cancel` now attempts a durable Stop for each outstanding shared child before cancelling the parent; errors are reported as UNKNOWN. Child Stop and timeout Stop are out of band, but neither an SDK abort nor an Executor cancellation intent proves rollback of previously started effects. Every replica subscribed to a parent dashboard room reads confirmed initial child completions without acquiring its owner lease. The installed SDK cannot safely inject messages into a running turn: **write_agent is next_turn only**. An isolated two-Runtime/real Socket.IO Executor lifecycle test with a local Kernel/model stub passes; **real Copilot SDK end-to-end behavior remains unverified**.
**Related Documents**: `packages/host/src/extensions/agent-tool.ts`, `packages/shared/src/subagent-policy.ts`, `docs/meta/adr/0014-subagent-approval-mode.md`

---

## 1. Problem Statement & Motivation

Prior to this design, `kala`'s `agent` tool operated purely in a **one-shot synchronous Fork-Join** model:
1. **No Ordered Follow-Ups or Warm Multi-Turn Reuse**:
   - Once `agent` was called, the parent blocked until the child completed or timed out.
   - If the child completed and the parent wanted to ask a follow-up question or request a small revision in the same area, the parent had to spawn a brand-new child session—discarding the child's entire warm conversation history, file exploration, and provider prompt cache.
   - A parent needs to queue new constraints for the next turn while a background child is still working; this is not mid-turn steering.
2. **No Cross-Agent Shared Coordination Board**:
   - When a parent spawned multiple sibling sub-agents (e.g., `research`, `implementation`, `test`), sibling sub-agents were completely isolated from one another.
   - Sibling agents could not publish discovered root causes, API contracts, or file-ownership claims to a shared session-tree board, leading to duplicated codebase searches or conflicting edits.

---

## 2. Design Overview

We introduce four cohesive capabilities across `packages/host/src/extensions/agent-tool.ts`, `packages/host/src/extensions/agent-board.ts`, and `packages/shared/src/subagent-policy.ts`:

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 1. `agent` Background Mode (`mode: 'sync' | 'background'`)                 │
│    - `mode: 'sync'` (default): blocks until completion (existing behavior) │
│    - `mode: 'background'`: creates child session, starts execution         │
│      asynchronously, and immediately returns `<sub_agent status="running"  │
│      session_id="..." />` so the parent can continue working or coordinate │
└──────────────────────────────────────┬─────────────────────────────────────┘
                                       │
          ┌────────────────────────────┴────────────────────────────┐
          ▼                                                         ▼
┌─────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
│ 2. `write_agent` & `read_agent`         │   │ 3. `agent_board` (Session-Tree Board)    │
│                                         │   │                                          │
│ - `write_agent`:                        │   │ - Scoped to the root Session tree        │
│   * If child is `done`/`idle`/`error`:  │   │   (parent + all child/descendant agents) │
│     resumes the SAME child session in   │   │ - Operations:                            │
│     place (`sync` or `background`),     │   │   * `post`: publish/update a topic entry │
│     reusing 100% of its warm context    │   │     with optional tags & revision check  │
│     and KV prompt cache!                │   │   * `read`: read one topic or filter     │
│   * If child is currently `running`:    │   │     by tag/author                        │
│     queues an incremental steering      │   │   * `list`: list all topics & metadata   │
│     message that is delivered as the    │   │   * `claim_file` / `release_file`:       │
│     next turn as soon as the current    │   │     advisory file locks across siblings  │
│     turn settles (never mid-turn).       │   │   * `clear`: clear board entries         │
│ - `read_agent`:                         │   │ - Automatically available to both parent │
│   * Inspects or awaits (`wait: true`,   │   │   and all sub-agent roles (`research`,   │
│     `timeout_ms`) a child sub-agent's   │   │   `implementation`, `test`, `review`)    │
│     status, turn count, latest output,  │   │                                          │
│     and pending steering messages.      │   │                                          │
└─────────────────────────────────────────┘   └──────────────────────────────────────────┘
```

---

## 3. Tool Specifications

### 3.1 `agent` (Extended with `mode: 'sync' | 'background'`)

- Added optional property `mode`:
  - `'sync'` (default): Waits for a bounded interval for the matching durable child turn; a timeout returns a running envelope, not a fabricated completion.
  - `'background'`: Durably creates the child and queues its first turn (counting toward `maxAgentFanOut` while active), then immediately returns:
    ```xml
    <sub_agent
      session_id="01J..."
      agent_type="research"
      intention=" trace auth token validation "
      status="running"
      turns="0"
      duration_ms="0"
    >
    <result>
    Sub-agent accepted in background. Use read_agent { agent_id: "01J...", wait: true } to await completion or write_agent { agent_id: "01J...", message: "..." } to queue a next-turn follow-up.
    </result>
    </sub_agent>
    ```

### 3.2 `read_agent`

- **Execution Kind**: `'host'`, **Risk**: `'read'`, `requiresApproval: false`
- **Parameters**:
  - `agent_id` (`string`, required): The `session_id` of a child sub-agent belonging to this parent session.
  - `wait` (`boolean`, optional, default `false`): When `true`, waits up to `timeout_ms` for the sub-agent (including any queued steering messages) to finish its active run.
  - `timeout_ms` (`integer`, optional, `1`–`600000`, default `30000`): Maximum time to wait when `wait: true`.
- **Authorization**: Verify `child.parentSessionId === sessionId` so a session can only read its own child sub-agents.
- **Cancellation**: Parent dashboard `client:cancel` enumerates outstanding durable child commands and attempts remote Stop enqueue before cancelling its own Runtime. This is not a terminal child cancellation acknowledgement; legacy local active children are also interrupted on the current process.
- **Deployment boundary**: Private Cloud permits independent generation-fenced Session owners on multiple Runtime replicas (see `docs/architecture/deployment-mode-contract.md`). A parent owner does **not** imply that its children share a process. The board transaction fences the calling child's owner and verifies the entire live tree inside PostgreSQL; initial child commands, ordered follow-ups, placement and out-of-band child Stop have child-owner routes. Parent `client:cancel` attempts Stop for all outstanding children, but cannot prove completed cancellation of remote effects.
- **Output**: Returns a `<sub_agent ...>` envelope reflecting current `status` (`running`, `completed`, `failed`, `cancelled`, `timed_out_with_partial_result`), `turns`, `duration_ms`, and latest assistant text or error.

### 3.3 `write_agent`

- **Execution Kind**: `'host'`, **Risk**: `'agent'`, `requiresApproval: false`
- **Parameters**:
  - `agent_id` (`string`, required): The `session_id` of an existing child sub-agent owned by this parent session.
  - `message` (`string`, required): Follow-up instruction queued for the sub-agent's next turn.
  - `mode` (`'sync' | 'background'`, optional, default `'sync'`):
    - If the child is currently running: queues `message` into the durable inbox behind its current turn. `mode === 'sync'` waits only for a bounded interval and may return a running/UNKNOWN envelope; `mode === 'background'` confirms admission, not execution.
    - If the child is resting (`done` / `idle` / `error`): enqueues `message` as the next user turn in the existing child session (`mode === 'sync'` waits only for a bounded interval; `mode === 'background'` returns after admission).

### 3.4 `agent_board`

- **Execution Kind**: `'host'`, **Risk**: `'read'`, `requiresApproval: false`
- **Scope Resolution**: Resolves the **Root Session ID** by walking live `parentSessionId` links under the board transaction. All parent and child sessions in the same tree share one durable board; the authoritative board row is removed with final root deletion. The process-local inspection cache is not authoritative.
- **Parameters**:
  - `operation` (`'post' | 'read' | 'list' | 'claim_file' | 'release_file' | 'clear'`, required)
  - `clear` is root-parent-only. File claims are advisory, bounded to 200 per board, and survive process restart; they do not enforce workspace file locking.
  - `topic` (`string`, optional): Topic key (`1..120` chars) for `post` / `read`.
  - `content` (`string`, optional): Markdown/JSON payload for `post` (max 32 KB).
  - `tags` (`string[]`, optional): Optional tags for filtering.
  - `path` (`string`, optional): File path for advisory `claim_file` / `release_file` coordination across parallel implementation agents.
  - `expected_revision` (`integer`, optional): Optimistic concurrency control on `post`.
- A resumed `write_agent` run receives a fresh role-based timeout and per-run turn ceiling (optionally narrowed by `timeout_ms` / `max_turns` on that call). It does not inherit the original call's custom budget after restart.

---

## 4. Verification & Acceptance Criteria (Portable / non-owner-fenced only)

1. **Background Launch + `read_agent` Wait**:
   - Parent launches a sub-agent with `mode: 'background'`, receives `status="running"` immediately, and then calls `read_agent { agent_id, wait: true }` to receive the completed `<sub_agent status="completed">` envelope.
2. **Live Steering + Multi-Turn Warm Reuse via `write_agent`**:
   - Calling `write_agent` on a completed child sub-agent appends a second `user_message` to the **same** `childSessionId`, preserving prior messages and returning the updated response.
   - Calling `write_agent` while a background sub-agent is still running queues a **next-turn** message; it executes only after the current turn has a durable terminal receipt. UNKNOWN blocks dispatch.
3. **Cross-Agent Shared Board (`agent_board`)**:
   - Parent and child sub-agents share the same board via root-session resolution.
   - Sibling sub-agents can `post`, `read`, `list`, and coordinate advisory file claims (`claim_file` / `release_file`, detecting conflicts when another sibling already holds the claim).

In a PostgreSQL-backed or owner-fenced Runtime, the board uses an atomic, owner-fenced transaction. The child inbox independently fences the submitting **parent** and claiming **child**, without assuming co-location. Initial shared child creation atomically commits the Session projection/event and its first command; the parent projection lock serializes fan-out against other child creations and queued follow-ups. A remote placement preference is stored in the child document before the child owner is released, so the creating replica cannot race to dispatch the first command; claim filtering falls back only when the target's Unit membership is no longer live. An owner-gated Host worker discovers pending children and delivers ordered messages as SDK/Kernel `user_message` with `operationId = commandId`. Dispatch runs in independent per-child tasks (at most 32 concurrent); the scan continues checking timeout and out-of-band Stop even while a runtime send is suspended. Saturation delays **new** message dispatch, never Stop/deadline scanning. Shutdown does not wait indefinitely on a suspended send or declare it complete. The worker marks dispatch **before** calling the runtime and completes the inbox item only after a read-only check of the matching durable turn's terminal state (`copilot.session_idle` linked by `childCommandId` and persisted user-message fingerprint, or a terminal Kernel state following the matching user event). A running child accepts a later steering message only when a durable message head already exists; it is queued behind that head, **not injected mid-turn**. An indeterminate or failed send stays claimed, with later messages blocked; a successor reclaims it but never re-sends it. Child-owner timeout checks use persisted initial child start or follow-up dispatch times to install a deterministic Stop barrier; they do not prove cancellation. Schema 17 persists each follow-up's own policy timeout and max-turn budget. Max-turn checks count unique persisted `assistant.turn_end` SDK turn IDs or Kernel `llm_response` events for **that command**, not assistant transcript fragments; legacy SDK runs without persisted turn-end events cannot be counted accurately and therefore must not be reported as meeting the ceiling. Later `write_agent` turns do not spend the initial command's budget. An SDK session belonging only to a former process cannot be aborted by a successor; its Stop outcome remains UNKNOWN. Likewise a missing journal/request provenance, a disconnect, or an unfinished/indeterminate Executor result cannot establish that the tool stopped. Sync `agent` waits up to 30 seconds for an inbox terminal outcome, then returns a **running** envelope, not a false completion; background `status=\"running\"` likewise confirms durable admission, **not** that the SDK turn has started. A completed Copilot child answer is selected by its durable turn ID even if later steering has already run; a Kernel transcript advanced past that turn cannot safely attribute the earlier reply and returns UNKNOWN rather than another turn's text. Explicit model overrides require an unambiguous advertised ref and pass the child's inherited organization/principal to tenant policy on submission and dispatch.

Schema 16 adds an initial-command completion outbox: the child owner commits the terminal outcome and timestamp; the **parent** owner polls it, checks the child-parent/call relationship, emits `sub_agent_finished` into its local dashboard room, then acknowledges the notice under the parent lease. In addition, *each* replica with a subscribed parent dashboard room reads confirmed completion rows directly, without acquiring the parent or child lease. A completion timestamp is assigned **before** commit and cannot be used as a safe commit-order cursor. Schema 18 assigns each confirmed message a per-parent monotonically increasing `completion_sequence` while holding the parent projection row lock **until commit**: the next transaction cannot assign its sequence before that commit/rollback. The migration backfills prior timestamped confirmed completions in timestamp order and rejects subsequent timestamped writers that omit sequence rather than silently losing notifications. A writer predating schema 16 that omits both timestamp and sequence is not supported in mixed-version rollout; all replicas must pass the feature-version deployment gate before accepting Board commands. Room fanout reads at most 128 rows **above** its durable sequence cursor per scan and retains only one cursor per subscribed parent room (plus the existing bounded short-term duplicate cache). It never cycles over completed history or retains an unbounded per-room ID set. A newly connected room replays its history once, paginated; a long history still takes time to catch up, but a steady-state subscription only queries newer sequences. A crash or disconnection before acknowledgement retries the parent notice; duplicates across connection epochs remain possible, so UI consumers must identify it by `(parentCallId, childSessionId)`. This is not end-to-end socket delivery acknowledgement, and it does not fabricate a completion for an UNKNOWN message, an unconfirmed Stop, or a command completed before schema 16. Shared `agent`/`read_agent` envelopes report durable model-turn terminals scoped to the child's inbox commands; existing portable envelopes still count assistant transcript messages and are **not** the durable SDK model-turn count.

The schema-18 regression holds an A transaction open after recording an earlier timestamp, commits B first, then commits A; B receives sequence 1 and A sequence 2, so a subscriber already past B still sees A. The same isolated PostgreSQL test paginates 1,100 completed child rows without cycling, and a worker test checks that notifications remain unique past the 1,024-entry short-term cache. A real PostgreSQL v17→v18 migration test verifies backfill and fail-closed rejection of an old writer omitting the sequence. These are storage/worker tests, not evidence that an unconfirmed SDK turn was cancelled.

The child completion writer now resolves the immutable command-parent relationship without taking a row lock, then locks the **parent projection before the child projection and command**, matching parent-owner enqueue. A controlled two-replica PostgreSQL test pauses enqueue while holding the parent row, starts completion on the other replica, and verifies both commit without a 40P01 deadlock; an injected 40P01 rollback leaves a dispatched claim intact for a fenced retry. A failed completion commit or lost commit acknowledgement does **not** release the child head: the worker retains the claim, repeatedly checks the matching durable SDK/Kernel terminal, and retries the fenced idempotent completion while its owner is live. A worker regression injects the commit failure and verifies no second send or early next message; another covers a lost claim acknowledgement plus a transient read failure. If the terminal cannot be proven or ownership is lost, the head remains UNKNOWN; no later message passes and no tool/model turn is replayed.

Dispatch-marker failure has a separate recovery path: a claimed **undispatched** head is not retried just because an in-memory claim exists. The live child owner must re-read the same durable head and generation, confirm the dispatch marker is absent, check that no SDK/Kernel operation exists under its `commandId` and that no Stop barrier is installed, then atomically mark **only if still undispatched** before re-running the normal policy/owner checks and sending once. A SQL rollback before the marker commit can therefore recover on the same owner without waiting for lease takeover. A successor reclaiming a previously claimed unmarked head must make the same checks before sending; an old owner stops monitoring when fenced. If the marker did commit but its ACK was lost, a prior SDK operation exists, or proof is unavailable, no owner resends: it keeps read-only terminal reconciliation/UNKNOWN and later messages blocked. Dashboard shows an undispatched **claimed** head as UNKNOWN, never as merely queued; an unresolved marker/SDK inconsistency requires manual investigation rather than automatic replay. Focused fault-injection worker tests and a real PostgreSQL mark-rollback/strict-CAS and generation-transfer test cover both the safe and unsafe branches. This cannot prove real SDK effects were rolled back.

The installed SDK's `send({mode:'immediate'})` returns a `messageId` when its prompt is **enqueued**; it does not provide a durable receipt that the active model consumed the steering, nor a terminal confirmation attributable to it after owner loss. `session.abort()` similarly does not certify that previously started tools were rolled back or that stale SDK callbacks cannot race a resumed turn; the former owner's SDK handle is unreachable after takeover. Therefore neither immediate mode nor abort+send is used as a purported hot steer. A safe bounded interrupt+resume needs an SDK turn-termination/consumption receipt, generation-fenced tool callback provenance and durable reconciliation of every in-flight Executor effect *before* admitting the queued steering command. Until those conditions are met, Stop is a barrier with UNKNOWN for unproven effects and `write_agent` remains ordered next-turn delivery, not hot steering.

### Receipt/Stop round-trip and remaining release blockers

1. Executor writes started/completed receipts under the **Executor workspace root** (`.kala/execution-receipts.json`), keyed by `sessionId:callId` and a digest of the tool request. The Host and Executor filesystems need not coincide. `tool:receipt_query` is now a **read-only** socket request carrying the child session ID, call ID, original owner generation and canonical request digest. The Executor reads and validates the whole on-disk journal (not its in-memory completion cache), returning `completed(result) | started_unknown | absent_with_valid_journal | conflict | unavailable`; missing/corrupt journals, legacy entries without provenance, and expired matching completions return `unavailable`. The Host registry routes only to the session's workspace Executor after socket authorization, asserts the current session owner before and after the acknowledgement, and rejects malformed replies, disconnections and owner changes. `absent_with_valid_journal` is only an observation of the current valid snapshot, **not** proof that a side effect was never accepted (pruning, crash and migration can remove evidence); never use it to automatically replay. This query is not yet connected to the persisted child-command/SDK turn reconciliation or exactly-once result projection. Completed receipts expire after 24 hours; started receipts block replay. The Host must link confirmed results to persisted commands/turns exactly once under the current child-owner generation; unknown outcomes stay blocked until explicit reconciliation.
2. The legacy `tool:cancel` remains fire-and-forget and cannot certify remote Stop. `tool:cancel_ack` now carries the child session ID, call ID, original owner generation, canonical request digest and Stop command ID, routed through the Host's authenticated workspace Executor binding. The Executor persists a `cancelRequestedAt`/`stopCommandId` marker **before** signalling the live runner. `cancel_requested` only certifies a durable intent and signal attempt, **not** cancellation, rollback or a completed effect. The child-owner worker requires a separate durable terminal receipt for every dispatched remote call, an acknowledged local SDK/Kernel abort, and no earlier dispatched message awaiting a durable turn terminal before reporting Stop acknowledged; otherwise it writes `UNKNOWN` as the Stop outcome. Even a confirmed completed tool receipt can contain effects made before Stop. `read_agent` exposes this status. An unconfirmed message remains claimed and a durable Stop barrier prevents later dispatch; a successor never blindly repeats a Stop whose acknowledgement was lost. Parent `client:cancel` attempts to enqueue Stop for every outstanding shared child. This is only an admission acknowledgement: remote SDK/Executor completion must still be reconciled, and failed admission reports UNKNOWN. Full run cancellation is not guaranteed.
3. Child-inbox messages now carry `commandId` as the SDK/Kernel turn `operationId`; a matching committed terminal projection permits inbox completion on takeover without replay. A dispatched command without such evidence remains UNKNOWN, including when an Executor receipt alone confirms one tool call. This is not a general recover/cancel protocol for SDK turns and cannot recover absent terminal projections automatically; no next child message may cross that head.
4. Shared child creation holds a parent row lock and inserts the child Session and initial inbox message in one event/projection transaction. Admission counts live child Session projections and distinct outstanding inbox children under the persisted parent limit, including concurrent sync and background tool calls. No process-local slot is used for shared creation. Existing legacy sessions lacking a durable initial command cannot receive running steering; no unconfirmed turn may release its fan-out reservation. Initial placement picks a different live Unit replica when available and hands off only the child lease; a dead target can be reclaimed after its membership expires. This is not a fairness scheduler or a guarantee of prompt progress when all remote replicas are unhealthy.

Inbox persistence, atomic creation/admission and owner-takeover tests cover the ordered initial child command and next-turn queue. Dashboard cards now share one `sub_agent:list` poll per socket and parent Session every two seconds, including previously completed cards; the Host queries active child-command rows for that parent in one read-only PostgreSQL query and projects each child without owning it. Polling retries unanswered requests after five seconds, ignores stale replies, shows UNKNOWN on query error/timeout, and stops when the last subscriber unmounts. Host Goal cancellation and Executor shell-approval behavior are preserved.

The opt-in `private-cloud-parallel-v1.integration.test.ts` Board case runs on an isolated internal Docker network with cached pinned images, genuine PostgreSQL, Gateway, two separate Host Runtime processes, and an authenticated remote Socket.IO Executor. A deterministic local OpenAI-compatible stub drives **Kernel**, not the Copilot SDK. The case creates a background child on the replica opposite its parent, holds its model reply while the next-turn `write_agent` remains pending, then releases the reply and checks both durable command terminals, real remote read-file receipts, and a cross-replica `sub_agent_finished` dashboard socket notification. It also checks a confirmed Stop after completion and, after killing the child owner during a second turn, generation takeover and an UNKNOWN Stop that leaves the unconfirmed message claimed. The `sub_agent:list` socket read checks processing/pending and UNKNOWN. Run with `KALA_RUN_PRIVATE_CLOUD_STORAGE_INTEGRATION=1 pnpm --dir packages/host exec vitest run src/tenant-runtime/private-cloud-parallel-v1.integration.test.ts -t 'routes durable next-turn'` (use a project-local `TMPDIR`); the suite removes UUID-labelled containers, network, volume and key files even after failure.

The real-Chromium `packages/dashboard/scripts/verify-board-prototype.mjs` check renders the actual Dashboard Board card against the **prototype's in-memory socket**, not a production Host. It asserts queued, processing **and** the still-pending next message (a review found the pending count was previously hidden while the head was processing), Stop click targeting the correct parent/call/child, UNKNOWN after Stop, and no fabricated terminal state. A focused component regression additionally blocks a late initial-completion push from briefly displaying **completed** over a still-outstanding/UNKNOWN command; only the durable list may clear that state. The browser blocks all network requests outside its localhost prototype origin. Start `pnpm --dir packages/dashboard exec vite --config vite.prototype.config.ts --host 127.0.0.1 --port 31889 --strictPort`; run the script with `BOARD_PROTOTYPE_URL=http://127.0.0.1:31889 CHROMIUM_PATH=<locally-installed-chromium> pnpm --dir packages/dashboard exec node scripts/verify-board-prototype.mjs`. On a machine with the pinned Puppeteer image already cached instead of a host Chromium executable, from the repository root use:

```sh
sudo -n docker run --rm --name kala-board-browser-check --network host --read-only \
  --tmpfs /state:rw,nosuid,size=256m --env TMPDIR=/state --env HOME=/state \
  --env XDG_CONFIG_HOME=/state/config --env XDG_CACHE_HOME=/state/cache \
  --env CHROME_PROFILE_DIR=/state/chrome-profile \
  --env BOARD_PROTOTYPE_URL=http://127.0.0.1:31889 \
  --mount "type=bind,source=$PWD,target=/app,readonly" --workdir /app/packages/dashboard --entrypoint node \
  ghcr.io/puppeteer/puppeteer@sha256:9665f5b57abc5cc7080a641878964018de219055a4d2c9d8d050ceb1161778ba \
  scripts/verify-board-prototype.mjs
```

The browser test is an in-memory **presentation/interaction** check; it does not turn the separate PostgreSQL/remote Executor socket E2E into a browser-to-Executor run.

The installed `@github/copilot-sdk@1.0.14` offers stdio/TCP/in-process CLI runtime connections and a URI connection to an existing runtime; the Host uses a bundled or configured CLI. None provides a documented local model-response injection transport that can establish genuine SDK delivery, abort rollback, and durable turn-end behavior offline without implementing a substitute CLI protocol. No remote LLM was contacted for this acceptance. The SDK's `sendAndWait`, `abort`, event listeners and `assistant.turn_end` behavior are instead exercised through the existing Vitest SDK mock, including a new owner-local Stop test: the successor without the original handle must return **unconfirmed** and not call abort, while the current process may request abort. These are **mock contract tests**, not real SDK/CLI end-to-end certification. A genuine Copilot SDK/model turn, production configuration and irreversible side-effect rollback remain unverified; a lost owner cannot abort its old SDK handle. UNKNOWN is not successful cancellation or permission to replay. Real SDK/Executor end-to-end behavior must be validated before release.
