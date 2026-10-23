# Wire Protocol

**Transport**: Socket.IO 4.x
**Serialization**: JSON (Socket.IO default)
**Status**: Normative.

This doc specifies every message that crosses process boundaries. If a Host/Dashboard/Executor implementation matches this doc, it interoperates.

---

## 1. Endpoints and namespaces

Host exposes a Socket.IO server at a single HTTP(S) port with two namespaces:

| Namespace | Who connects | Direction |
|---|---|---|
| `/dashboard` | Dashboard SPA | Inbound to Host |
| `/executor` | Executor (Node daemon or browser WebContainer) | Inbound to Host |

Both use the same underlying transport. Namespaces isolate the routing logic.

**Rooms**: Both namespaces use rooms named `session:<sessionId>` for per-session fan-out.

---

## 2. Handshake (both namespaces)

On connect, the client sends an authentication payload via Socket.IO's `auth` field:

```ts
type HandshakeAuth = {
  role: 'dashboard' | 'executor'
  sessionId?: string         // required for `dashboard`; MUST be absent for `executor`
  token?: string             // bearer token for private deployments / executors
  invite?: string            // executor invite token from `POST /auth/executor-invites`
  clientVersion: string      // e.g. "@agent-kernel/executor@0.1.0"
}
```

Host validates:
- Dashboard connections MUST carry a `sessionId` (the session they subscribe to). It matches an existing session OR the connection is allowed to lazy-create one on first user message.
- Executor connections MUST NOT carry a `sessionId` — an executor is a daemon that serves any session whose `workspaceId` matches its accepted identity (see §5).
- `role` matches the namespace (`role: 'executor'` MUST use `/executor`)
- Executor handshakes use one of three identities: `invite` for first-time onboarding, a saved long-term `token`, or an explicitly configured static token. If the host has an executor identity store configured, anonymous executor handshakes MUST be rejected.
- Executor tokens may be scoped to one `workspaceId`; if so, `executor:announce.workspaceId` MUST match that scope.
- When GitHub OAuth is required, dashboard handshakes are authorized by the host-issued login cookie, not by the executor token.

**On success (dashboard)**: server calls `socket.join(\`session:\${sessionId}\`)` and sends a `session:ready` event (see §3).

**On success (executor)**: connection is accepted; the executor MUST then emit `executor:announce` (§5.1) to become routable. The host validates the announcement against the authenticated executor identity before accepting it. No `session:ready` is sent.

**On failure**: server disconnects with a reason string (`auth_failed`, `unknown_session`, `role_mismatch`, `version_incompatible`, `missing_session_id`, `workspace_identity_mismatch`).

---

## 3. Common events (Host → all clients in a session room)

Host broadcasts these to any client joined to `session:<sessionId>`.

### 3.1 `session:ready`

Emitted once per client, right after handshake succeeds.

```ts
{
  sessionId: string
  agentRuntime: 'kernel' | 'copilot'
  executionMode: 'chat' | 'dag'
  agentRuntimeCapabilities: {
    queue: boolean
    fork: boolean
    compact: boolean
    clear: boolean
    approvalMode: boolean
    workspace: boolean
    cwdMutation: boolean
    modelSelection: boolean
    attachments: boolean
    memoryConsolidation: boolean
    customTools: boolean
    nativeReasoning: boolean
  }
  runtimeCompactionPolicy: {
    authority: 'host' | 'runtime'
    automatic: {
      enabled: boolean
      mode: 'safe_boundary' | 'background'
      warningThreshold: number
      startThreshold: number
      blockingThreshold?: number
      concurrentWorkAllowed: boolean
    }
    manual: {
      supported: boolean
      whileActive: 'reject' | 'queue' | 'runtime_managed'
    }
    summary: {
      authority: 'host' | 'runtime'
      validation: 'host_gate' | 'runtime_reported'
    }
  }
  compactStatus?: CompactStatusEvent // active root attempt at hydration time
  cursor: number              // current event cursor of the session
  state: AgentState           // current snapshot (see SPEC §1.4)
  config: AgentConfig         // (see SPEC §1.3)
  contextSnapshot?: ContextSnapshot // host-owned context estimate for UI/policy
  turnStartedAt?: string       // ISO 8601 start of latest committed user turn; absent on legacy hosts/no turn
  parentSessionId?: string    // for forked sessions
  parentCursor?: number       // fork point on the parent
  workspaceId?: string        // routing key — the workspace this session is bound to (§5.1). Undefined for legacy sessions predating the field.
  workspaceName?: string      // display label for the workspace, snapshotted at session-create time
  selectedModel?: string      // per-session model override, if one has been set
}
```

`runtimeCompactionPolicy` is the effective policy for this Session, not a
Dashboard default. Kernel Sessions publish their configured soft/hard
thresholds and Host authority. Copilot Sessions publish the thresholds passed
to the SDK, runtime authority, and whether background work may continue.
Clients must not infer these semantics from `agentRuntime`.

`compactStatus` restores an active root attempt for a Dashboard that attaches
or reconnects after the `server:compact_status` running broadcast. Terminal
attempts remain represented by the transcript/runtime metadata and are not
replayed as active.

`server:compact_status` lifecycle payloads may additionally carry `authority`,
root/subagent `scope`, and immutable `startSnapshot` /
`completionSnapshot` values. The current `state:changed.contextSnapshot` is a
separate, later measurement; clients must not present it as the trigger
snapshot.

### 3.2 `state:changed`

Emitted after every kernel `step` call that mutated state.

```ts
{
  sessionId: string
  cursor: number              // = state.cursor (matches SPEC I1)
  state: AgentState
  contextSnapshot?: ContextSnapshot
  turnStartedAt?: string       // same durable latest-turn start as session:ready
}
```

`turnStartedAt` is a Host-owned projection, not Kernel state. For Kernel sessions it is recovered from the latest committed `user_message` timing (or that durable event timestamp); for external runtimes it is recovered from durable user-message runtime metadata. It remains stable through thinking, tools, approval, and terminal state until the next committed user turn. A `session:ready` baseline is authoritative; legacy hosts may omit the field.

For bandwidth reasons, clients MAY subscribe to `event:appended` instead and reconstruct state locally by applying events to their last-known snapshot. v1 servers send both.

### 3.3 `event:appended`

Emitted after every kernel `step` call, including no-ops (per SPEC I1, no-ops still advance cursor).

```ts
{
  sessionId: string
  seq: number                 // = state.cursor after this event; 1-indexed
  ts: string                  // ISO 8601 timestamp of when Host applied this event
  event: AgentEvent           // the event that was applied
  effects: Effect[]           // effects the kernel emitted for this event
  llmTrace?: LLMTrace         // optional provider-level trace for llm_response
  model?: string              // model used for llm_response / llm_error, even when llmTrace is absent
}
```

Dashboards use this to draw the event timeline. `llmTrace` is metadata on
the log entry, not a kernel event and not part of `AgentState`. It is present
only for LLM responses recorded by hosts that capture provider traces. The
trace includes the final provider request URL, redacted headers, request body,
response status, and either the raw response body or a compact streaming
summary. Authorization secrets MUST be redacted before persistence.

`model` is also event metadata. Hosts SHOULD include it on `llm_response` and
`llm_error` events whenever the active model is known, even if provider request
capture was disabled or the adapter did not return an `llmTrace`.

**Extended event kinds**: `event.kind` may be `messages_replaced`,
`approval_mode_changed`, or `cwd_changed` in addition to the base v0.1 union.
Successful context compaction is represented as
`messages_replaced(reason='compaction')`. Summarizer request/response details
belong in runtime metadata or artifacts, not in the kernel event.

### 3.4 `session:error`

Emitted when the kernel enters `status: 'error'`, or when Host's own machinery hits an unrecoverable issue.

```ts
{
  sessionId: string
  scope: 'kernel' | 'llm' | 'executor' | 'host'
  message: string
}
```

`scope` values:

- `kernel` — an invariant inside the pure FSM was violated (should be impossible in practice; treat as a bug).
- `llm` — the LLM adapter (OpenAI/Anthropic) surfaced an error we bubbled through `onLlmError`; kernel is now in `status: 'error'`.
- `executor` — the executor side of Host's registry surfaced an error (bad tool_result payload, unhandled dispatcher exception, etc.).
- `host` — Host's own machinery (session lookup, handshake validation, socket wiring). The `unknown_session` message on the executor namespace uses this scope (see §2).

---

## 4. Dashboard-specific events

### 4.1 Dashboard → Host

The dashboard's job is to inject user-originated events into the kernel.

#### `client:user_message`

```ts
{
  sessionId: string
  text: string
  mode?: 'steer' | 'queue'
  content?: MessageContent[]
}
```

Host translates to `{ kind: 'user_message', text, content? }` and feeds to
`step` when the session is idle. `mode: 'steer'` is the default: during an
active turn the host cancels the current stream if needed and promotes the
message at the front of the next safe delivery boundary. `mode: 'queue'` holds
the message until the current turn finishes, then promotes queued messages in
FIFO order. Queue state is surfaced with `server:message_queue`; dashboards
must render pending message previews instead of showing only a count.

Queued messages are host-side delivery state, not kernel state. Reorder,
edit, and delete operations below update only that queue and then rebroadcast
`server:message_queue`.

Generic file bytes are uploaded before admission:

```http
POST /runtime/attachments?sessionId=<session-id>
Authorization: Bearer <dashboard token>
Content-Type: <file media type>
X-Agent-RunLab-Attachment-Name: <encodeURIComponent(display name)>

<raw file bytes>
```

The Host stores bounded bytes in content-addressed, Session-associated storage
and returns a `ReferencedFileContent`. New `client:user_message` and durable
admission payloads carry only this reference:

```ts
{
  type: 'file'
  name: string
  mediaType: string
  source: {
    kind: 'host_ref'
    attachmentId: string // UUID
    sha256: string       // lowercase hex
    bytes: number        // 1..2 MiB
  }
}
```

The historical `{ type:'file', name, mediaType, data:<base64> }` form remains
valid for replay compatibility, but browsers must not use it for new generic
file submissions. References are validated against the target Session before
delivery. Kernel resolves UTF-8 text on demand and rejects binary content;
Copilot receives a controlled Host file path inside its Host-owned SDK working
directory. Its SDK tool surface enables only the built-in `view` reader in
addition to RunLab custom tools, and the permission handler approves that
reader only for the exact Session-owned attachment path; all other Host reads
are rejected. Kernel text and UTF-8 validation happens during upload so an
unsupported binary file fails before message admission.

Uploads are pending leases until a message using the reference is accepted by
the Host. The Dashboard releases pending references after a rejected
submission or a partially failed multi-file upload:

```http
POST /runtime/attachments/release
Authorization: ****** token>
Content-Type: application/json

{
  "sessionId": "<session-id>",
  "attachmentIds": ["<attachment-uuid>"]
}
```

Committed references cannot be released through this endpoint. Abandoned
pending uploads expire after 24 hours and are removed when the attachment
store loads or receives another upload. Physical content is removed only when
no Session record references its hash. Active and candidate Runtime processes
refresh the shared registry on reads and serialize mutations with an
interprocess lock, so uploads remain resolvable across a blue/green cutover.
Upload, release, and portable message admission require a write-capable actor;
an organization `viewer` receives HTTP 403. Dedicated public ingress strips
client-provided organization identity headers before authentication or
proxying.

If message admission becomes durable before attachment commitment finishes,
the endpoint returns a retryable error with the same `operationId` and
`durablyAccepted: true`. Clients must retry or monitor that operation identity;
they must not release its attachments or restore the draft as a new message.

#### `client:reorder_queued_message`

```ts
{
  sessionId: string
  id: string
  beforeId?: string | null
}
```

Move an undelivered queued message before `beforeId`. If `beforeId` is null or
omitted, move it to the end. No kernel event is emitted.

#### `client:update_queued_message`

```ts
{ sessionId: string; id: string; text: string }
```

Edit an undelivered queued message. No kernel event is emitted.

#### `client:delete_queued_message`

```ts
{ sessionId: string; id: string }
```

Delete an undelivered queued message. No kernel event is emitted.

#### `client:user_approve`

```ts
{ sessionId: string; callId: string }
```

Host → `{ kind: 'user_approve', callId }`.

#### `client:user_reject`

```ts
{ sessionId: string; callId: string; reason?: string }
```

Host → `{ kind: 'user_reject', callId, reason }`.

#### `client:ask_user_choice`

```ts
{ sessionId: string; callId: string; value: string }
```

Resolves a pending host-side `ask_user_choice` tool call. The host validates
that the call is still pending and that `value` is one of the tool-provided
choices, then returns the selected value to the model as a `tool_result`.

#### `client:cancel`

```ts
{ sessionId: string }
```

Host → `{ kind: 'cancel' }`. Also aborts the in-flight LLM stream if any.

#### `client:clear`

```ts
{ sessionId: string }
```

Host → `{ kind: 'clear' }`. Clears the current session transcript, pending
calls, todos, memory, and token usage while keeping the same session id,
workspace binding, cwd, model, and approval mode. If a turn is active, Host
also cancels pending tools and aborts the in-flight LLM stream before applying
the event. This is the wire command behind the `/clear` slash command; it does
not create a new session.

#### `client:cancel_stream`

```ts
{ sessionId: string }
```

Abort the in-flight LLM call *without* leaving the FSM. Any streamed text so
far becomes the final assistant message with a `[cancelled]` suffix, so the
event log always sees a complete `llm_response`. No-op if nothing is
streaming. Wired to the dashboard ESC key during a `thinking` turn.

#### `client:compact`

```ts
{ sessionId: string }
```

Ask the host to summarize stale transcript context with the summarizer LLM.
Emitted from the exact `/compact` input; the dashboard does not append
`/compact` as a `user_message`. Host chooses a safe replacement range,
summarizes that range, preserves the required tail verbatim, and records a
`messages_replaced(reason='compaction')` event. Attempt metadata is written as
runtime metadata/artifacts.

#### `client:set_approval_mode`

```ts
{ sessionId: string; mode: 'auto' | 'ask' | 'deny' | 'allow_all' }
```

Host → `{ kind: 'approval_mode_changed', mode }`. `allow_all` is refused
unless the host was started with `KALA_ALLOW_ALL_OK=1`.

#### `client:set_cwd`

```ts
{ sessionId: string; cwd: string }
```

Change the session's current working directory. Host validates the path
against the bound executor's sandbox before dispatching
`{ kind: 'cwd_changed', cwd }`. The session must already exist, must be at rest
(`idle`, `done`, or `error`), and any bound workspace must have an attached
executor so sandbox roots are known. Failures are reported with `session:error`;
the host must not silently accept a cwd that the reducer will ignore.
Subsequent `tool:call` payloads carry the new `cwd`.

#### `client:set_model`

```ts
{ sessionId: string; model: string }
```

Override the model used for this session's LLM calls. Host echoes back
`session:model_changed` so all dashboards on the room show the new picker
value.

#### `client:rename_session`

```ts
{ sessionId: string; label: string }
```

Set (or clear, with an empty string) the operator-defined display label for
this session. Host appends a metadata entry to the JSONL log and broadcasts a
refreshed `server:sessions` payload so every dashboard picks up the new
label. When cleared, `SessionSummary.label` becomes undefined and the
Explorer falls back to `firstUserMessage`.

#### `client:rename_workspace`

```ts
{ workspaceId: string; workspaceName: string }
```

Set the operator-defined display label for a workspace. `workspaceId` remains
the stable routing key; this event does not move sessions or change executor
routing. Host persists the alias, updates any existing session metadata for
that `workspaceId`, broadcasts `workspace:renamed`, refreshes
`server:executors`, and re-broadcasts `server:sessions` so online and offline
workspace labels stay consistent.

#### `client:delete_session`

```ts
{ sessionId: string }
```

Host removes the session from its in-memory map and unlinks the JSONL log
file. Broadcasts `server:session_deleted` and a refreshed `server:sessions`
listing. The socket is disconnected — dashboards subscribed to the room must
navigate away or open a new session.

#### `client:create_session`

```ts
{
  sessionId: string           // Dashboard-generated id for the new session
  agentRuntime?: 'kernel' | 'copilot' // defaults to kernel
  executionMode?: 'chat' | 'dag' // defaults to chat; immutable after creation
  workspaceId: string         // executor workspace to bind to
  workspaceName?: string      // display label snapshot
  cwd?: string                // initial working directory
}
```

Host creates a fresh JSONL log with the header populated. If `cwd` is
provided it is validated against the executor's sandbox roots before it
becomes the session's `initialCwd` / initial `state.cwd`. Responds with
`session:ready` for the new sessionId; the dashboard MUST `emit('subscribe',
newSessionId)` after receiving the reply.

The Host rejects unavailable runtimes. Copilot Sessions are owned by the
official GitHub Copilot SDK runtime; their RunLab logs contain authoritative
projection snapshots and runtime metadata rather than synthetic Kernel events.

#### DAG-First lifecycle

`executionMode: 'dag'` creates a Session whose durable task graph is stored by
the Host. These request/response events are operation-id protected:

```ts
client:get_dag_run          { sessionId, operationId } -> DagRun | null
client:initialize_dag       { sessionId, objective, nodes, edges, operationId } -> DagRun
client:answer_dag_decision  { sessionId, runId, decisionId, answer, operationId } -> DagRun
```

The Host broadcasts every authoritative graph change to subscribed dashboards:

```ts
server:dag_run { sessionId, run: DagRun }
```

`DagRun` contains versioned nodes and edges, durable node state, child Session
links, decisions, and an append-only event projection. Standard Chat Sessions
reject DAG initialization and never receive DAG workspace UI.

#### `client:list_dirs`

```ts
{
  requestId: string
  workspaceId: string         // executor to ask
  path?: string               // directory to list; defaults to first sandbox root
}
```

Powers the new-session Finder-style directory picker. Host forwards to the
executor as `fs:list_dirs` (§5.2) and returns the reply as `server:dir_list`.
Keyed by `workspaceId` because no session exists yet.

#### `client:list_files`

```ts
{
  requestId: string
  workspaceId: string
  query?: string
  limit?: number
}
```

Dashboard-driven file search for composer file mentions. Host forwards to
`fs:list_files`; response is `server:file_list`.

#### `client:read_file`

```ts
{
  requestId: string
  workspaceId: string
  path: string
  maxBytes?: number
}
```

Dashboard-driven read of a workspace file for file mention expansion or file
view. Host forwards to `fs:read_file`; response is `server:file_contents`.

#### `client:read_overflow`

```ts
{
  requestId: string
  sessionId: string
  callId: string
}
```

Read the spill file for a tool result whose full output exceeded the inline
cap. Host resolves the session's `workspaceId`, forwards to
`fs:read_overflow`, and replies with `server:overflow_contents`.

#### `client:delete_overflow_session`

```ts
{
  requestId: string
  sessionId: string
}
```

Delete every spill file belonging to a session. Fired when the dashboard
deletes a session so the workspace's `.kala/overflow/<sessionId>/`
directory does not leak disk space. Host forwards to
`fs:delete_overflow_session`; the ack carries `{ deleted: boolean, error? }`.
Idempotent — deleting a session whose overflow dir does not exist returns
`deleted: true`.

#### `client:copy_overflow_session`

```ts
{
  requestId: string
  sourceSessionId: string
  targetSessionId: string
}
```

Duplicate a session's spill files under a new sessionId. Fired during
`client:fork` so the forked child inherits the parent's spilled tool
outputs (kept in step with the inlined-truncated tool_result entries in the
child's JSONL header). Host forwards to `fs:copy_overflow_session`; the ack
carries `{ copied: boolean, error? }`. No-op with `copied: true` when the
source directory does not exist.

#### `client:fork`

```ts
{
  sourceSessionId: string
  cursor: number              // fork after this cursor
  newSessionId?: string       // if omitted, Host generates one
  seedMessage?: string        // optional first user_message to dispatch on the child
}
```

Host replays the source event log up to `cursor` into a new session with
`newSessionId`, then treats the new session as active. Responds with
`session:forked` for the new session. If `seedMessage` is present, Host
dispatches it as the child's first `user_message` after the fork is
materialized. This powers "edit and rerun" without a second round trip.

#### `subscribe`

```ts
{ sessionId: string }
```

Explicitly join an additional session room after the initial handshake. Response: `session:ready` on success.

#### `client:list_executors`

```ts
{}
```

Request the currently-attached executors on this Host. Response: `server:executors` on the same socket.

#### `client:list_sessions`

```ts
{}
```

Request the sessions currently on this Host (JSONL logs under the Host's session directory). Response: `server:sessions`.

#### `client:load_history`

```ts
{
  sessionId: string
  sinceCursor?: number        // if omitted, return the full log from cursor 1
}
```

Request the historical timeline for a session. Response: `server:history` with the log entries. Dashboard fires this on `session:ready` so the timeline survives page reloads.

### 4.2 Host → Dashboard only (not executor)

#### `session:token_delta`

Streaming text token forwarded straight from the LLM adapter. UI-only —
dashboards concatenate deltas into a partial assistant row for the current
`thinking` turn. The event log is still authoritative through the final
`llm_response`; if a client misses deltas the timeline reconstructs the same
message from the log.

```ts
{
  sessionId: string
  text: string                 // one delta chunk
}
```

#### `session:model_changed`

Broadcast after Host applies a `client:set_model`. Dashboards use it to
sync the model picker across tabs viewing the same session.

```ts
{
  sessionId: string
  model: string
}
```

#### `approval:required`

Sent when the kernel emits a `request_approval` effect. Dashboard renders a confirm UI.

```ts
{
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
}
```

#### `server:message_queue`

Sent whenever the host's per-session delivery queue changes, and once after a
dashboard subscribes so reconnects show the current pending deliveries.

```ts
{
  sessionId: string
  pending: number
  items: Array<{
    id: string
    text: string
    mode: 'steer' | 'queue'
    createdAt: string
    content?: MessageContent[]
    shell?: {
      command: string
      state: 'queued' | 'running' | 'completed' | 'nonzero' | 'failed'
      result?: string
    }
  }>
}
```

`pending` is a convenience mirror of `items.length`. The dashboard snapshot
contains queued follow-ups; transient `mode: 'steer'` deliveries are not shown.
For a Host-owned `intent: 'shell'` request, `shell.state` is durably projected
by original `id`: `queued`, then `running`, then a terminal `completed`,
`nonzero`, or `failed` state. The optional terminal `result` is the same safe
plain user-message envelope committed to Session history; stdout and stderr in
that envelope remain untrusted process data.

Dashboard resolves via `client:user_approve` or `client:user_reject`.

#### `server:executors`

Response to `client:list_executors`.

```ts
{
  executors: Array<ExecutorAnnounce & { attachedAt: string }>
}
```

Each entry is the announcement payload the executor sent, plus the ISO-8601 timestamp Host recorded when the executor attached. Older executors omit the `hostname` / `os` / `ipAddresses` / `pid` / `startedAt` fields — the Dashboard falls back to `executorId` in that case.

#### `server:executor_changed`

Broadcast (not response-scoped) whenever an executor attaches, detaches, or re-announces. Executors are daemons — a change affects all sessions whose `workspaceName` matches or previously matched this executor.

```ts
// attached | updated:
{
  change: 'attached' | 'updated'
  executorId: string
  executor: ExecutorAnnounce & { attachedAt: string }
}
// detached:
{
  change: 'detached'
  executorId: string
  // no `executor` field — the executor is gone
}
```

`updated` fires when the same executor re-announces with different capabilities (e.g., after a reconnect).

#### `workspace:renamed`

Broadcast after `client:rename_workspace` succeeds.

```ts
{
  workspaceId: string
  workspaceName: string
}
```

Dashboards may use this as a low-latency signal, but the canonical refreshed
views are still `server:executors` and `server:sessions`.

#### `server:sessions`

Response to `client:list_sessions`. Also re-broadcast after
`client:rename_session` and `client:delete_session` so every dashboard's
Explorer stays in sync without individually re-issuing the list request.

```ts
{
  sessions: Array<{
    sessionId: string
    agentRuntime: 'kernel' | 'copilot'
    createdAt: string          // from JSONL header
    lastEventAt?: string       // ts of the last event line, if any
    eventCount: number
    parentSessionId?: string   // set if this session was forked
    workspaceId?: string       // routing key — matches an executor's announced workspaceId (§5.1). Undefined for legacy sessions.
    workspaceName?: string     // display label captured at session-create time. Not authoritative; the live executor's `workspaceName` is what the dashboard shows when one is attached.
    executorId?: string        // reserved for v2 (Host doesn't record which executor produced a tool_result in v1)
    status?: AgentState['status']  // last snapshot's status, if a snapshot exists
    currentCwd?: string        // folded `state.cwd`, if any. Displayed under the session row and used as the workbench cwd fallback before the live snapshot arrives.
    firstUserMessage?: string  // first ~120 chars of the first user_message; used as row label when no operator label is set
    label?: string             // operator-set display label from `client:rename_session`; takes precedence over `firstUserMessage`
  }>
}
```

#### `server:agent_runtimes`

Emitted on dashboard connection and alongside `client:list_sessions`
responses. Carries each runtime's readiness, implementation version, and
capabilities so creation and Session controls can be gated by the server.

Host derives these fields by reading each session's JSONL header + scanning events. The scan is `O(events)` per session; if a Host tracks many sessions this endpoint may want caching, but v1 reads on demand.

#### `server:history`

Response to `client:load_history`.

#### Storage inventory and cleanup

Storage inventory is lazy. Cached queries do not scan the filesystem; callers
set `refresh: true` when they explicitly want a metadata-only reconciliation.
The Host reads only session headers and file metadata, never complete JSONL
transcripts.

```text
client:get_session_storage { sessionId, refresh? }
  -> ACK RpcAck<SessionStorageSnapshot>

client:get_global_storage { refresh? }
  -> ACK RpcAck<GlobalStorageSnapshot>
```

Destructive cleanup uses a two-phase protocol:

```text
client:prepare_storage_cleanup { operation, targetId }
  -> ACK RpcAck<StorageCleanupPlanPreview>

client:execute_storage_cleanup { planId }
  -> ACK RpcAck<StorageCleanupResult>
```

Preparation returns only a sanitized preview, never absolute Host paths. The
Host records an exact inode manifest and expiry internally. Execution
revalidates ownership, active Session state, path boundaries, symlinks, file
identity and the complete manifest before any move. Successful execution
atomically quarantines data on the same filesystem; it does not permanently
unlink quarantine contents. Sub-agent detail cleanup preserves a tombstone and
the parent Session's durable result. Dashboard deletion surfaces require two
explicit operator confirmations between preparation and execution.

```ts
{
  sessionId: string
  entries: EventAppendedEvent[]   // same shape as live event:appended
}
```

Every entry has the same shape as a live `event:appended` payload — Dashboard can feed them into its timeline state the same way. Entries are ordered by `seq` ascending. Dashboard dedups by `seq` in case a live `event:appended` overlaps the tail of history.

#### `server:dir_list`

Response-scoped reply to `client:list_dirs`. Dashboard uses this to populate the new-session Finder-style directory picker before a session exists, so the request is keyed by `workspaceId` instead of `sessionId`.

```ts
{
  requestId: string
  workspaceId: string
  path: string              // resolved directory path that was listed, or the requested path on error
  roots: string[]           // executor sandbox roots visible to the picker
  entries: Array<{
    name: string
    path: string
  }>
  error?: string
}
```

#### `server:file_list`

Response-scoped reply to `client:list_files`.

```ts
{
  requestId: string
  workspaceId: string
  files: Array<{ path: string; size: number }>
  truncated: boolean
  error?: string
}
```

#### `server:file_contents`

Response-scoped reply to `client:read_file`.

```ts
{
  requestId: string
  workspaceId: string
  path: string
  content?: string
  size?: number
  error?: string
}
```

#### `server:overflow_contents`

Response-scoped reply to `client:read_overflow`.

```ts
{
  requestId: string
  sessionId: string
  callId: string
  content?: string
  size?: number
  error?: string
}
```

#### `server:session_deleted`

Fires once after `client:delete_session` completes. Dashboards watching the
deleted session close their view and navigate away.

```ts
{ sessionId: string }
```

#### HTTP `GET /models`

Returns the host's current model registry. Models come from
`~/.claude/settings.json`, `~/.codex/config.toml`, legacy env fallback, and
manual entries in `~/.config/kala/models.json`.

```ts
type ModelInfo = {
  id: string
  label: string
  provider: string
  providerId?: string
  source?: 'claude-settings' | 'codex-config' | 'env' | 'manual'
  contextWindow?: number
}

{
  models: ModelInfo[]
  defaultModel: string
}
```

#### HTTP `GET /settings`

Returns a sanitized settings snapshot. API keys and helper command output are
never serialized. Provider credentials are still owned by the underlying Claude
Code / Codex / environment config; dashboard writes are limited to manual model
ids under existing providers.

```ts
{
  providers: Array<{
    id: string                // e.g. "anthropic", "newapi"
    label: string
    wire: 'anthropic' | 'openai'
    source?: 'claude-settings' | 'codex-config' | 'env' | 'manual'
    baseUrl?: string
    models: ModelInfo[]
  }>
  defaultModel: string
  paths: {
    claudeSettings: string
    codexConfig: string
    manualModels: string
    hooksConfig: string
    sessionsDir: string
  }
  hooks: Array<{ event: string; command: string; match?: string }>
  mcp: { supported: false; note: string }
  release?: {
    bootstrapBaseUrl: string
    source: 'local' | 'github'
  }
}
```

`release.bootstrapBaseUrl` is the asset base used by the dashboard's Connect
Workspace command. When `source` is `github`, the value is already an absolute
GitHub Release download URL and clients should use it as-is. When `source` is
`local`, the host serves direct release filenames under `/release-assets/*` from
its local `release/` directory; browser clients should resolve that path against
the current dashboard origin so a dashboard opened through a LAN IP or DNS name
does not generate commands that point remote executors at their own
`localhost`.

#### HTTP `POST /settings/models`

Adds or updates a manual model id bound to an existing provider endpoint, then
returns the same payload as `GET /settings`.

```ts
{
  providerId: string
  id: string
  label?: string
  contextWindow?: number
}
```

#### HTTP `DELETE /settings/models?providerId=<id>&id=<model>`

Deletes a manual model entry, if present, then returns the same payload as
`GET /settings`. Auto-discovered models from Claude Code / Codex / env config
are read-only in this endpoint.

`ModelInfo.contextWindow` combined with `AgentConfig.contextLimit` drives the
Composer context usage ring. `ModelInfo.source` lets the dashboard distinguish
auto-discovered entries from manual ones.

#### HTTP `POST /auth/executor-invites`

Creates a permanent executor invite credential. When GitHub OAuth is required,
the request MUST carry a valid host login cookie. Plaintext invite tokens are
returned only from create/regenerate responses; list responses never include
token material. The Connect Workspace dialog uses this endpoint and labels its
records `Connect Workspace`; Settings → Executor access uses the same endpoint
for operator-created invites.

```ts
{
  id: string
  inviteToken: string          // opaque, starts with `ak_invite_`
  label?: string
  workspaceId?: string         // optional pre-binding; otherwise first use binds
  createdAt: string            // ISO-8601
}
```

#### HTTP `GET /auth/executor-invites`

Returns invite summaries without plaintext tokens or token hashes.

```ts
{
  invites: Array<{
    id: string
    label?: string
    workspaceId?: string
    createdAt: string
    lastUsedAt?: string
    revoked: boolean
  }>
}
```

#### HTTP `PATCH /auth/executor-invites/:id`

Updates invite metadata. Supported fields are `label` and `workspaceId`; setting
`workspaceId` to `null` clears the binding.

#### HTTP `DELETE /auth/executor-invites/:id`

Revokes an invite. Revoked invites cannot authenticate new executor handshakes.
If the invite was bound to a workspace, the host also removes that workspace's
saved reconnect identity.

```ts
{ ok: true; id: string; revoked: boolean }
```

#### HTTP `POST /auth/executor-invites/:id/regenerate`

Rotates an invite token and returns the new plaintext token once. Regeneration
clears any workspace binding, removes that workspace's saved reconnect identity,
and un-revokes the invite record.

#### HTTP `GET /auth/executor-identities`

Returns saved executor identity summaries. Plaintext tokens and token hashes are
never serialized.

```ts
{
  identities: Array<{
    workspaceId: string
    label?: string
    createdAt: string
    lastSeenAt?: string
  }>
}
```

#### HTTP `DELETE /auth/executor-identities?workspaceId=<id>`

Revokes the saved reconnect identity for one workspace. A currently connected
executor may remain online until its socket drops; the next reconnect requires a
fresh invite.

```ts
{ ok: true; workspaceId: string; revoked: boolean }
```

---

### 4.3 Background-shell control plane

Runs alongside the three built-in tools (`bash{run_in_background}`, `bash_output`, `kill_shell`). The tools remain the way the *agent* starts, reads, and kills background tasks; the RPCs here are how the *dashboard operator* observes and controls the same tasks without prompting the agent. See `docs/host/background-shell-design.md`.

Routed by `workspaceId` and owned by `sessionId`. A background task lives in the executor's registry, but only the session that spawned it can list, read, or kill it by default. Sibling sessions in the same workspace do not receive task pushes and cannot access the task through `bg:*` RPCs.

Shared type:

```ts
type BackgroundTaskStatus = 'running' | 'exited' | 'killed' | 'signaled'

type BackgroundTaskSummary = {
  taskId: string
  sessionId: string
  command: string
  cwd: string
  startedAt: string            // ISO
  endedAt?: string             // ISO, present iff status ≠ 'running'
  status: BackgroundTaskStatus
  exitCode: number | null      // null while running or terminated by signal
  signal: string | null
  bytesLogged: number          // includes bytes lost to ring-buffer wrap
  bytesTruncated: number       // bytes dropped when the ring buffer wrapped
}
```

#### `bg:list` (Dashboard → Host → Executor, ack)

```ts
// Request
{ requestId: string; workspaceId: string; sessionId: string }
// Ack
{
  requestId: string
  workspaceId: string
  sessionId: string
  tasks: BackgroundTaskSummary[]
  error?: string             // e.g. 'no executor attached'
}
```

Returns every task owned by `sessionId` in the executor's registry (including tasks that already exited but haven't been evicted yet — see `docs/host/background-shell-design.md` §4.1 for the 15-minute grace window).

#### `bg:output` (Dashboard → Host → Executor, ack)

```ts
// Request
{
  requestId: string
  workspaceId: string
  sessionId: string
  taskId: string
  offset?: number            // byte offset into bytesLogged; missing → whole current buffer
  maxBytes?: number          // cap on returned slice (default 64 KiB, hard cap 1 MiB)
}
// Ack
{
  requestId: string
  workspaceId: string
  sessionId: string
  taskId: string
  content: string
  nextOffset: number         // pass back on the next poll to continue tailing
  done: boolean              // true iff the task has ended
  status: BackgroundTaskStatus
  bytesTruncated: number
  error?: string             // 'unknown task' | 'no executor attached'
}
```

Reads a slice of the log without blocking. If `offset` is behind the ring-buffer window (task produced more than 4 MiB since that offset), executor returns the current buffer contents and the caller detects the gap via `bytesTruncated`. Dashboard polls this at ~1.5 s for the *selected* task; push events short-circuit the poll for other visible tasks.

The executor rejects `taskId` values not owned by `sessionId` with `error: 'unknown task'` so task existence is not leaked across sessions.

#### `bg:kill` (Dashboard → Host → Executor, ack)

```ts
// Request
{ requestId: string; workspaceId: string; sessionId: string; taskId: string }
// Ack
{
  requestId: string
  workspaceId: string
  sessionId: string
  taskId: string
  killed: boolean            // false iff the task was already exited/killed
  error?: string
}
```

Sends SIGTERM to the child. The subsequent `close` triggers a `bg:task_updated` push with `status: 'killed'` and `endedAt` set.

#### `server:bg_task_updated` (Host → Dashboard, push)

Fan-out from the executor's registry event stream. Emitted on spawn, on task end, and every ~400 ms during a burst of output (throttled at the executor). Room-scoped: only dashboards subscribed to the task's owning session receive it.

```ts
{
  workspaceId: string
  sessionId: string
  task: BackgroundTaskSummary
  delta?: {                  // present when new output caused this update
    fromOffset: number       // offset within task.bytesLogged where the delta begins
    content: string
  }
}
```

The dashboard's live-tail reducer appends `delta.content` at `delta.fromOffset` when it holds the immediately-prior byte, and refetches via `bg:output` on gap (e.g. it just selected the task).

#### `server:bg_task_evicted` (Host → Dashboard, push)

```ts
{ workspaceId: string; sessionId: string; taskId: string }
```

Sent 15 min after a task's `endedAt`. Dashboard drops the task from its map. Late `bg:output` reads for an evicted taskId return `error: 'unknown task'`.

---

### 4.4 Sub-agent control plane

Runs alongside the `agent` builtin tool (`packages/host/src/extensions/agent-tool.ts`). The tool is how the *parent LLM* starts a child session and receives its final assistant text back as a wrapped envelope in `tool_result.content`. The events + RPCs here are how the *dashboard operator* observes and interrupts the child inline while it runs — otherwise the parent's chat panel would show a spinner for the full duration of the child's inner loop. See `docs/host/sub-agent-design.md`.

Routed by `sessionId`. Push events fan into the parent's `session:<parentSessionId>` room; the dashboard uses `childSessionId` from `sub_agent_started` to open a subscription on the child's own room (using the existing `subscribe` verb) and render its `event:appended` stream inline.

#### Envelope in `tool_result.content`

The parent's `tool_result` from the `agent` tool is wrapped so the dashboard can render a `SubAgentCard` without heuristics and so the log line is self-describing under `less`. Wrapper is text (not JSON) so it degrades to plain text acceptably when the UI hasn't been updated:

```
<sub_agent
  session_id="<child sessionId>"
  agent_type="<name or general-purpose>"
  status="completed"
  turns="7"
  duration_ms="42137"
>
<result>
…final assistant text (HTML-entity-escaped `<`/`>`)…
</result>
</sub_agent>
```

Failure envelopes replace `<result>` with `<error>…</error>` and set `status="failed"`. Interrupted children use `status="cancelled"` with the cancellation reason in `<error>`. Missing / malformed envelopes fall back to the plain grouped-tool-call renderer.

#### `server:sub_agent_started` (Host → Dashboard, push)

Emitted by the host at the moment `runAgentTool()` creates the child session, *before* the child's inner loop begins. Fired into the parent's room only.

```ts
{
  parentSessionId: string
  parentCallId: string           // the parent's `agent` tool_call callId
  childSessionId: string
  agentType?: string             // from the agent-type registry; undefined for anonymous spawns
  prompt: string
  model?: string                 // per-call override, if the parent passed one
  startedAt: string              // ISO 8601
}
```

Dashboards use this to (a) mark the parent's SubAgentCard as running, (b) subscribe to `session:<childSessionId>` so the inline nested transcript starts streaming immediately, and (c) show a "N sub-agents running" indicator without waiting for the envelope.

#### `server:sub_agent_finished` (Host → Dashboard, push)

Emitted just before `runAgentTool()` returns. Fired into the parent's room only.

```ts
{
  parentSessionId: string
  parentCallId: string
  childSessionId: string
  status: 'completed' | 'failed' | 'cancelled'
  turns: number                  // child.state.cursor at finish (approximate)
  durationMs: number
  finishedAt: string             // ISO 8601
  error?: string                 // present iff status !== 'completed'
}
```

The corresponding `<sub_agent>` envelope arrives shortly after inside the parent's `tool_result` `event:appended`; the finished push is what lets the dashboard freeze the card and stop the running timer even before the parent's turn advances.

#### `client:interrupt_sub_agent` (Dashboard → Host, push)

Interrupts one active child from the parent's inline `SubAgentCard`. The host marks the active child as cancelled, then dispatches a normal `cancel` event to the child session through the host loop so LLM stream abort and executor `tool:cancel` behavior reuse the same cancellation path as top-level sessions.

```ts
{
  parentSessionId: string
  parentCallId: string           // the parent `agent` tool_call callId
  childSessionId?: string        // optional stale-row guard
}
```

If the child is still active, the parent room receives `server:sub_agent_finished` with `status: 'cancelled'`, and the parent later receives a `<sub_agent status="cancelled">` envelope in the `tool_result`. If the child has already finished or the `childSessionId` guard does not match, the host emits `session:error` to the parent session and leaves the already-finished result unchanged.

#### `sub_agent:list` (Dashboard → Host, ack)

Reconstructs children for a parent session when its log is reopened. Reads from `SessionStore` by scanning records with `parentSessionId === X`.

```ts
// Request
{ requestId: string; parentSessionId: string }
// Ack
{
  requestId: string
  parentSessionId: string
  children: Array<{
    childSessionId: string
    parentCallId: string
    agentType?: string
    status: 'running' | 'completed' | 'failed' | 'cancelled'
    startedAt: string
    finishedAt?: string
  }>
  error?: string
}
```

#### `agent_types:list` (Dashboard → Host, ack)

Returns the currently-loaded agent-type registry (built-ins + workspace `.kala/agents/` + user `~/.config/kala/agents/`). Powers the Composer's `@agent-name` mention menu.

```ts
// Request
{ requestId: string }
// Ack
{
  requestId: string
  types: Array<{
    name: string
    description: string
    model?: string
    tools?: string[]
    systemPromptPreview?: string  // first ~200 chars of the body
  }>
  error?: string
}
```

---

### 4.5 Real-desktop control plane

Dashboard sends `computer:request` with an ACK callback. The shared strict
`ComputerRequestSchema` is authoritative. Every request contains `requestId`,
`workspaceId`, `sessionId` and one operation:

| Operation | Additional fields |
|---|---|
| `status` | none |
| `start` | `consent: true`, `allowAgent: boolean` |
| `renew`, `stop`, `capture` | `leaseId: UUID` |
| `input` | `leaseId`, `action: ComputerInputAction` |
| `agent` | `leaseId`, `allowAgent: boolean` |

The ACK is `{requestId, status?, leaseId?, screenshot?, error?}`. Errors contain
`{code, message}`, where code is `unavailable`, `denied`, `busy`, `expired`,
`invalid_request`, or `execution_error`. Legacy routing/runtime middleware can
instead reject with a generic `{ok:false,error:string}`; clients must display it.
Status contains `available`, `platform`, `active`, `allowAgent`, optional
`reason`, `sessionId` and `expiresAt` (Unix milliseconds).

`ComputerInputAction` is a strict `type`-discriminated union:
`move{x,y}`, `click{x,y,button,clickCount?}`, `button{x,y,button,down}`,
`scroll{x,y,deltaX,deltaY}`, `key{key}`, `type{text}`, or
`drag{fromX,fromY,toX,toY}`. Buttons are `left|middle|right`; click count is 1 or 2.
Coordinates are physical desktop integers, including negative monitor origins.
Scroll deltas are wheel units (120 per notch, positive Y down), not pixels.
Typing is bounded to 512 UTF-16 code units and supports newline/tab but no other
control characters.

A screenshot is `{mimeType:'image/png',base64,width,height,originX,originY}`.
Base64 is bounded to 6 MiB so the RPC fits the existing 8 MiB transport limit.
The image occupies `(originX,originY,width,height)` on the physical desktop.

The Host requires workspace/session channel access, tenant/session/workspace
authorization, writable Dashboard access and active Runtime ownership. It derives
the controller identity from `socket.id`, never request arguments, and forwards
the request to the announced `__computer_use` Executor tool with `origin:'host'`.
The Executor also requires local machine opt-in. Its single controller lease is
bound to that socket and session, expires after 30 seconds without Dashboard
renewal, and is revoked on disconnect. Stop and Agent pause can cancel queued
desktop work. Manual input pauses Agent control. The model's `computer_use`
tool can only check status, capture a screenshot or send input under a currently
authorized Agent-enabled lease; it cannot manage authorization.

Manual screenshots are transient, not transcript entries. Agent screenshots
use the bounded JSON carrier `{kind:'kala.computer-use.screenshot.v1',screenshot}`
inside the existing string tool result; model adapters convert it into image
blocks. Do not send the base64 carrier as ordinary prompt text.

## 5. Executor-specific events

Executor is a pure RPC responder. It receives commands from Host, executes them, and replies. It never originates state-changing events. **An executor is a daemon**: one process serves N sessions. It has no session binding at connect time; Host routes each `tool:call` to it based on the session's `workspaceId` (see §5.1).

### 5.1 Executor → Host (on connect)

#### `executor:announce`

Sent by executor immediately after the handshake succeeds. Declares the workspace this executor represents plus its capabilities and machine metadata (used by the Dashboard's Workspaces column).

```ts
{
  executorId: string          // client-generated stable id (usually a ULID)
  workspaceId: string         // REQUIRED. Stable ULID minted on the executor's first launch and persisted (default `~/.kala/workspace-id`). Sessions bind to this in their JSONL header (see event-log.md §3); Host routes `tool:call` by matching `session.workspaceId` against a live announce. Never renamed — a lost or regenerated id detaches the machine's existing sessions, which is why the executor refuses to boot with a corrupted id file.
  workspaceName: string       // REQUIRED. Human-readable display label. Free to change via `--name` — routing goes by workspaceId, not this. Falls back to `os.hostname()` when the operator doesn't pass a name.
  tools: string[]             // public implementation names this executor can serve
  toolImplementations?: Array<{ name: string; version?: string; schemaHash?: string }>
  installId?: string          // stable managed-install identity
  executorVersion?: string    // executor package/release version
  build?: { version?: string; commit?: string; builtAt?: string }
  capabilities?: Record<string, unknown>
  defaultCwd?: string
  sandboxRoots?: string[]     // optional filesystem jail(s). Empty / omitted = executor trusts whole machine (defers to OS user permissions).
  workingDir?: string         // for logging/display only; NOT part of the workspace identity.
  runtime: 'node' | 'browser-webcontainer' | 'other'
  runtimeVersion: string
  // Machine metadata — all optional. An older executor that doesn't
  // populate these still works; the Dashboard falls back to executorId.
  hostname?: string           // os.hostname()
  os?: 'linux' | 'darwin' | 'win32' | 'other'  // normalized os.platform()
  ipAddresses?: string[]      // non-loopback, non-link-local IPv4/IPv6
  pid?: number                // process.pid
  startedAt?: string          // ISO-8601, executor process boot time
}
```

A workspace is a machine identity with one or more filesystem roots. `workspaceName` is display-only and free to change; existing sessions stay bound via `workspaceId`. In public deployments, `workspaceId` MUST be validated against the authenticated executor token scope before the host accepts the announce.

Host stores the attach in a registry keyed by `executorId`. A second `executor:announce` from the same executorId replaces the first entry and fires `server:executor_changed { change: 'updated' }` (§4.2).

If the executor handshake used `invite`, the host validates that the invite is
not revoked, binds the first announced `workspaceId` when the invite is still
unbound, updates `lastUsedAt`, persists only a hash of a newly minted long-term
token, and replies with `executor:welcome`. Subsequent uses of the same invite
must announce the same bound `workspaceId`.

### 5.2 Host → Executor

#### `executor:welcome`

Sent after a successful invite-based attach. The executor persists `token`
locally and uses it for future reconnects. The invite remains valid until it is
revoked or regenerated.

```ts
{
  token: string                // opaque long-term token, starts with `ak_exec_`
  workspaceId: string          // workspace identity the host bound the token to
}
```

#### `executor:host_reject`

Permanent failure sent immediately before host-side disconnect.

```ts
{
  code: 'workspace_id_conflict' | 'workspace_identity_mismatch' | 'version_incompatible' | 'auth_failed'
  message: string
}
```

#### `tool:call`

Sent when Host needs the executor to run a tool. The same wire message carries
kernel-originated tool calls and host-internal RPCs. The executor does not know
or decide whether the result enters the agent transcript.

```ts
{
  sessionId: string
  callId: string
  name: string
  input: Record<string, unknown>
  origin?: 'host'             // Set only by Host-internal RPC construction. Never copy model input into this authorization marker.
  cwd?: string                // session's current working directory, copied from state.cwd. Executor merges it into the tool input as the default cwd.
  timeoutMs?: number          // Host's soft deadline. Executor SHOULD respect it.
}
```

**Reply**: executor MUST reply via Socket.IO ACK **or** via `executor:tool_result`. ACK is preferred (better error handling):

```ts
// Ack payload:
{
  callId: string
  ok: boolean
  content: string             // stringified result / error
}
```

For kernel-originated calls, Host translates the reply into
`{ kind: 'tool_result', callId, ok, content }` and feeds it to `step`. For
host-internal RPCs such as `__fs_list_dirs`, `__fs_read_file`, `__bg_list`, and
`__bg_kill`, Host parses the ACK and returns it only to the original dashboard
or HTTP caller. Transcript routing remains Host-local. The optional `origin`
marker authenticates management operations such as `__computer_use`; it does
not independently decide transcript routing.

#### `tool:cancel`

Sent when the kernel emits a `cancel` event and pending calls need to be interrupted.

```ts
{ sessionId: string; callId: string }
```

Executor SHOULD attempt to interrupt the running tool. Executor MUST reply (via ACK or `executor:tool_result`) even if the tool had already completed — reply with `ok: false, content: 'cancelled'` in the ambiguous case.

### 5.3 Executor → Host (outside of a tool:call response)

#### `executor:tool_result`

Alternative to Socket.IO ACK. Useful when a tool completes long after the initial `tool:call` (streaming tools, long bash commands).

```ts
{
  sessionId: string
  callId: string
  ok: boolean
  content: string
}
```

#### `executor:bg_task_updated`

Emitted from the executor's `subscribeBackgroundTasks` callback whenever a background task spawns, produces new output (throttled to ~400 ms), or ends. Host rebroadcasts to the owning session room as `server:bg_task_updated` (§4.3).

```ts
{
  workspaceId: string
  sessionId: string
  task: BackgroundTaskSummary
  delta?: { fromOffset: number; content: string }
}
```

Payload is identical to `server:bg_task_updated` — Host relays it verbatim after validating the task's `workspaceId` matches the executor registration.

#### `executor:bg_task_evicted`

Emitted 15 minutes after a task's `endedAt`. Host rebroadcasts as `server:bg_task_evicted` (§4.3).

```ts
{ workspaceId: string; sessionId: string; taskId: string }
```

---

## 6. Message routing summary

| Origin | Message | Target |
|---|---|---|
| Dashboard | `client:user_message` | Host (kernel) |
| Dashboard | `client:user_approve` | Host (kernel) |
| Dashboard | `client:user_reject` | Host (kernel) |
| Dashboard | `client:ask_user_choice` | Host (human-input tool) |
| Dashboard | `client:cancel` | Host (kernel) |
| Dashboard | `client:clear` | Host (kernel) |
| Dashboard | `client:cancel_stream` | Host (LLM adapter) |
| Dashboard | `client:interrupt_sub_agent` | Host (sub-agent control plane) |
| Dashboard | `client:compact` | Host (kernel) |
| Dashboard | `client:set_approval_mode` | Host (kernel) |
| Dashboard | `client:set_cwd` | Host (kernel) |
| Dashboard | `client:set_model` | Host (routing) |
| Dashboard | `client:rename_session` | Host (storage) |
| Dashboard | `client:delete_session` | Host (storage) |
| Dashboard | `client:create_session` | Host (storage) |
| Dashboard | `client:get_dag_run` | Host (DAG state) |
| Dashboard | `client:initialize_dag` | Host (DAG state) |
| Dashboard | `client:answer_dag_decision` | Host (DAG state) |
| Dashboard | `client:fork` | Host (kernel + storage) |
| Dashboard | `client:list_executors` | Host (routing) |
| Dashboard | `client:list_sessions` | Host (storage) |
| Dashboard | `client:get_session_storage` | Host (storage inventory) |
| Dashboard | `client:get_global_storage` | Host (storage inventory) |
| Dashboard | `client:prepare_storage_cleanup` | Host (safe cleanup) |
| Dashboard | `client:execute_storage_cleanup` | Host (safe cleanup) |
| Dashboard | `client:list_dirs` | Host → Executor (`fs:list_dirs`) |
| Dashboard | `client:list_files` | Host → Executor (`fs:list_files`) |
| Dashboard | `client:read_file` | Host → Executor (`fs:read_file`) |
| Dashboard | `client:read_overflow` | Host → Executor (`fs:read_overflow`) |
| Dashboard | `client:delete_overflow_session` | Host → Executor (`fs:delete_overflow_session`) |
| Dashboard | `client:copy_overflow_session` | Host → Executor (`fs:copy_overflow_session`) |
| Dashboard | `bg:list` | Host → Executor (`bg:list`) |
| Dashboard | `bg:output` | Host → Executor (`bg:output`) |
| Dashboard | `bg:kill` | Host → Executor (`bg:kill`) |
| Dashboard | `sub_agent:list` | Host (storage) |
| Dashboard | `agent_types:list` | Host (registry) |
| Dashboard | `client:rename_workspace` | Host (storage) |
| Dashboard | `client:load_history` | Host (storage) |
| Dashboard | `subscribe` | Host (routing) |
| Executor | `executor:announce` | Host (routing) |
| Executor | ACK to `tool:call` | Host (kernel) |
| Executor | `executor:tool_result` | Host (kernel) |
| Executor | `executor:bg_task_updated` | Host → Dashboard (session room) |
| Executor | `executor:bg_task_evicted` | Host → Dashboard (session room) |
| Host | `session:ready` | Dashboard OR Executor |
| Host | `session:token_delta` | Dashboard only |
| Host | `session:model_changed` | Dashboard only |
| Host | `workspace:renamed` | Dashboard only (broadcast) |
| Host | `state:changed` | All in room |
| Host | `event:appended` | All in room |
| Host | `session:error` | All in room |
| Host | `approval:required` | Dashboard only |
| Host | `server:executors` | Dashboard only (response) |
| Host | `server:executor_changed` | Dashboard only (broadcast) |
| Host | `server:sessions` | Dashboard only (response + broadcast) |
| Host | `server:session_deleted` | Dashboard only (broadcast) |
| Host | `server:dag_run` | Dashboard only (response + broadcast) |
| Host | `server:history` | Dashboard only (response) |
| Host | `server:dir_list` | Dashboard only (response) |
| Host | `server:file_list` | Dashboard only (response) |
| Host | `server:file_contents` | Dashboard only (response) |
| Host | `server:overflow_contents` | Dashboard only (response) |
| Host | `server:bg_task_updated` | Dashboard only (session room broadcast) |
| Host | `server:bg_task_evicted` | Dashboard only (session room broadcast) |
| Host | `server:sub_agent_started` | Dashboard only (parent session room) |
| Host | `server:sub_agent_finished` | Dashboard only (parent session room) |
| Host | `tool:call` | Executor only |
| Host | `tool:cancel` | Executor only |
| Host | `fs:list_dirs` | Executor only |

---

## 7. Error handling

### 7.1 Auth failure

Host disconnects the socket immediately with `{ reason: string }`. Client MUST NOT retry the same handshake without changing auth.

### 7.2 Tool call timeout

If executor does not reply to `tool:call` within `timeoutMs` (default: **60000ms**, configurable per session):
- Host synthesizes `{ kind: 'tool_result', callId, ok: false, content: 'tool call timed out after Xms' }` and feeds to kernel
- Kernel proceeds as if the tool failed
- If executor eventually replies, the reply is discarded (its callId is no longer in `pendingCalls`; kernel treats as no-op)

### 7.3 Executor disconnected while calls pending

Host detects via Socket.IO `disconnect`. For every pending `call_tool` the disconnected executor was serving:
- Synthesize `tool_result(ok=false, content='executor disconnected')`
- Feed to kernel

The session moves forward. When a fresh executor announces with a matching `workspaceId` (typically the same daemon reconnecting after a restart — the persisted id file makes this stable), Host resumes routing to it for that workspace's sessions.

### 7.4 Dashboard disconnected

No kernel action needed. On reconnect and re-subscribe, Host sends `session:ready` with current state. Dashboard fires `client:load_history` after `session:ready` to rebuild the timeline (see §4.1). It MAY pass `sinceCursor` to limit the response to entries the tab hasn't seen.

### 7.5 LLM error

`llm_error` events happen inside Host (not from clients). Kernel enters `error` status; Host broadcasts `session:error` with `scope: 'llm'`. Clients decide UX (typically show a retry button that emits a fresh `user_message`).

---

## 8. Reconnection semantics

Socket.IO handles TCP-level reconnection. On reconnect:

1. Client re-sends handshake auth (Socket.IO does this automatically if `reconnection: true`).
2. Server calls `socket.join('session:...')` again.
3. Server emits `session:ready` with current state.
4. Dashboard fires `client:load_history` with the last seen `cursor` (or none, for a fresh tab). Host responds with `server:history`, and Dashboard merges the entries into its timeline (dedup by `seq`).

Executors don't need timeline replay on reconnect — they only care about `pendingCalls`, which Host redispatches from its in-memory registry.

---

## 9. Versioning and backward compatibility

The `clientVersion` field in handshake auth lets Host reject clients too old to speak the current protocol. Version bumps:

- **Patch** (e.g. `0.1.0` → `0.1.1`): documentation fixes, no wire change
- **Minor**: add new event kinds. Old clients ignore unknown events
- **Major**: remove or repurpose existing events. Old clients rejected at handshake

Server exposes its protocol version in the `session:ready` payload (v2 field: `protocolVersion`).

---

## 10. Full type definitions

Wire protocol types live in `packages/shared/src/protocol.ts` and are imported by `core`, `executor`, and `dashboard`. Any change to this doc MUST update `packages/shared/src/protocol.ts` in the same PR.

**Import example**:

```ts
import type {
  HandshakeAuth,
  SessionReadyEvent,
  ToolCallMessage,
  ToolResultAck,
} from '@agent-kernel/shared'
```

---

## 11. Example: full session flow

```
Dashboard connects:
  → HandshakeAuth { sessionId: 's1', role: 'dashboard', clientVersion: '0.1.0' }
  ← session:ready { sessionId: 's1', cursor: 0, state: {…}, config: {…} }

User types "hi":
  → client:user_message { sessionId: 's1', text: 'hi' }
  ← event:appended { seq: 1, event: { kind: 'user_message', text: 'hi' }, effects: [{ kind: 'call_llm', ... }] }
  ← state:changed { cursor: 1, state: {status: 'thinking', …} }

Host calls Anthropic; response contains a tool_call for 'read':
  ← event:appended { seq: 2, event: { kind: 'llm_response', message: {…}, usage: {…} }, effects: [{ kind: 'call_tool', callId: 'c1', name: 'read', … }] }
  ← state:changed { cursor: 2, state: {status: 'executing_tools', pendingCalls: [{callId: 'c1', status: 'dispatched'}]} }

  (Executor was already announced. Host emits tool:call to it, waits for ACK.)

Executor replies via ACK:
  { callId: 'c1', ok: true, content: 'file contents…' }
  ← event:appended { seq: 3, event: { kind: 'tool_result', callId: 'c1', ok: true, content: '...' }, effects: [{ kind: 'call_llm', ... }] }
  ← state:changed { cursor: 3, state: {status: 'thinking', pendingCalls: []} }

Host calls Anthropic again; plain text answer:
  ← event:appended { seq: 4, event: { kind: 'llm_response', message: {…} }, effects: [{ kind: 'finish' }] }
  ← state:changed { cursor: 4, state: {status: 'done'} }
```

This session yields 4 lines in the JSONL event log (see [event-log.md](event-log.md) §3).
