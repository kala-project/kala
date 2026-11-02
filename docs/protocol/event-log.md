# Event Log Format

**Format**: JSONL (one JSON object per line, UTF-8, LF-terminated)
**Legacy JSONL storage**: `~/.kala/sessions/<iso-timestamp>_<sessionId>.jsonl`
**Status**: Normative entry representation; physical storage authority follows the [deployment SoT](../architecture/deployment-mode-contract.md).

For Kernel sessions, the durable event sequence and creation header in the selected
Session authority reconstruct state by folding `event` entries. New SQLite/PG
profiles persist that authority in their database, not a required local JSONL
file; exports and projections are not a second writer. Existing legacy JSONL
installations retain their original log authority without automatic migration.
The file conventions below describe that legacy format and serialized exports,
not a requirement to restore node-local file authority in cloud deployments.

For external runtimes such as GitHub Copilot, the RunLab JSONL is a
**projection log**, not a replay log. The external runtime owns its native
conversation semantics; Kala persists bounded projections, runtime metadata,
the stable native Session mapping. New SQLite/PG profiles bind durable native
SessionFs state to that selected Unit authority; disposable SDK scratch is not
authority. Online Host paths MUST NOT fully scan
or fold an external-runtime JSONL. They must use the header, the latest snapshot,
sidecar context snapshots, and bounded reverse metadata lookups. Full reads of
external-runtime logs are allowed only for explicit offline export/audit code
paths that opt in at the call site.

---

## 1. File conventions

### 1.1 Path

```
~/.kala/sessions/<startedAt>_<sessionId>.jsonl
```

- `startedAt`: ISO 8601 timestamp with `:` replaced by `-`, e.g. `2026-07-04T17-30-15Z`
- `sessionId`: ULID (26 chars, sortable, URL-safe alphabet)

Example: `~/.kala/sessions/2026-07-04T17-30-15Z_01J1XZ8T4W9F2A3B4C5D6E7F8G.jsonl`

The path itself is not read back — only the file contents are authoritative. The naming aids listing and human debugging.

### 1.2 Line format

Each line is a JSON object with the fields defined in §2, no trailing whitespace, terminated by a single `\n`. The file MUST end with a newline. Empty lines are illegal.

Files are append-only. No rewriting, no truncation. A corrupted line at the tail (partial write from a crash) may be discarded on load if it fails to parse; the rest of the log stays valid.

---

## 2. Log entry schema

There are five kinds of entries: `header`, `event`, `snapshot`, `metadata`, and `runtime_metadata`. `header`, `event`, and `snapshot` carry a cursor `seq`; metadata entries do not advance the kernel cursor.

```ts
type LogEntry = {
  kind: 'header' | 'event' | 'snapshot' | 'metadata' | 'runtime_metadata'
  seq: number                 // 0 for header, 1..N for event/snapshot
  ts: string                  // ISO 8601 with millisecond precision
}
```

### 2.1 Header (kind: 'header')

The first line of every log file. Written once when the session is created.

```ts
type HeaderEntry = {
  kind: 'header'
  seq: 0
  ts: string
  sessionId: string
  parentSessionId?: string            // present iff this session is a fork or a child agent session
  parentCursor?: number               // fork point in the parent session's log
  delegationDepth?: number            // non-negative safe integer; authority depth, not ancestry length
  workspaceId?: string                // routing key: the workspace (a machine) this session is bound to. Written once at create time; Host uses it to route `tool:call` to the executor announcing the same id. Undefined for legacy logs predating the field — treated as "unassigned".
  workspaceName?: string              // display label captured at create time. Not authoritative — the live executor's `workspaceName` is what the dashboard shows when an executor is attached.
  organizationId?: string             // ingress tenant attribution. Required by commercial SaaS quota/isolation enforcement for tenant-scoped sessions.
  principal?: string                   // ingress-authenticated principal that created or backfilled the session attribution.
  organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
  initialCwd?: string                 // initial working directory for the session. Validated at create time against the workspace sandbox roots and mirrored into `initialState.cwd`.
  formatVersion: 1                    // bumps on breaking log-format change
  kernelVersion: string               // e.g. "@agent-kernel/kernel@0.1.0"
  config: AgentConfig                 // frozen at session start
  initialState: AgentState            // AgentState *before* seq 1 is applied. Reducer-owned protocol state only.
}
```

The header captures the session's initial conditions; its captured `config` is not rewritten for every event. Current Runtime implementations may update while delegated tools remain bounded by their durable creation manifest. Child sessions created by the host-side `agent` tool reuse the ancestry fields (`parentSessionId`, `parentCursor`) — the agent tool is not a separate log kind.

New roots persist `delegationDepth: 0`; an agent-created child persists its parent's effective depth plus one. A supported Fork inherits the source depth, including zero, without resetting delegated tool ceilings. The same value governs agent admission and Runtime tool-scope reload in both cached and cold records. Absence denotes legacy data: parent/agent provenance without an explicit depth remains conservatively scoped at depth at least one; a legacy root without such provenance is depth zero. This optional version-1 field does not migrate old installations or infer authority by walking process-local ancestor caches.

### 2.2 Event (kind: 'event')

The primary entry type for Kernel sessions. One per `step()` call, in order.

```ts
type EventEntry = {
  kind: 'event'
  seq: number                 // = state.cursor after this event was applied
  ts: string                  // when Host applied step()
  event: AgentEvent           // exactly as fed to step() (SPEC §1.5)
  effects: Effect[]           // exactly what step() returned (SPEC §1.6)
  usage?: UsageTotal          // cumulative usage after this step (only when it changed)
  llmTrace?: LLMTrace         // provider HTTP trace metadata for LLM events, when captured
  model?: string              // active model for llm_response / llm_error, even without llmTrace
}
```

`effects` is included for observability (dashboard timeline, debugging). Replay does **not** need `effects` — the kernel re-derives them from `(state, event, config)`. Effects in the log are a checked-in-transcript artifact; if a replay produces different effects, the kernel implementation drifted from the recorded run.

External-runtime sessions MUST NOT append synthetic Kernel `event` entries for
provider turns. Their transcript changes are projected through `snapshot` and
`runtime_metadata` entries. If a Host detects Kernel events in an external log,
it must quarantine the Session instead of folding those events into state.

**Extended event kinds**: `event.kind` may be `messages_replaced`,
`approval_mode_changed`, or `cwd_changed` in addition to the base v0.1 union
in SPEC §1.5. `cwd_changed` is the durable source for `AgentState.cwd`;
session summaries derive `currentCwd` by folding the log. Successful context
compaction is represented as `messages_replaced` with
`reason: 'compaction'`. Summarizer request/response/debug metadata belongs in
artifacts or `runtime_metadata`, not in the kernel event.

**Storage of `usage`**: To keep log lines small, `usage` is written only on lines where it changed (i.e. after an `llm_response` with a delta). Consumers reconstructing running usage can pull it from these lines.

**LLM metadata**: `llmTrace` and `model` are observability metadata, not kernel
state. `llmTrace` stores the redacted provider request/response when capture is
available. `model` stores the model selected for the call and SHOULD be present
on `llm_response` and `llm_error` entries whenever known, including failures and
calls where provider trace capture is unavailable.

### 2.3 Metadata (kind: 'metadata')

Written by the host on operator actions that don't change kernel state —
currently only `client:rename_session`. Multiple metadata entries may exist;
readers walk them in reverse to find the most recent value per field.

```ts
type MetadataEntry = {
  kind: 'metadata'
  seq: 0                      // metadata entries do not advance the cursor
  ts: string
  label?: string              // operator-set display label; empty string clears the override
  workspaceId?: string
  workspaceName?: string
  organizationId?: string
  principal?: string
  organizationRole?: 'owner' | 'admin' | 'member' | 'viewer'
  selectedModel?: string
  toolCardMode?: 'dots' | 'standard'
}
```

An empty `label` acts as a clear signal — the session summary falls back to
`firstUserMessage` when the latest label entry is empty.

### 2.4 Snapshot (kind: 'snapshot')

Optional. Written periodically or on demand to accelerate replay.

```ts
type SnapshotEntry = {
  kind: 'snapshot'
  seq: number                 // same value as the event line that produced this state
  ts: string
  state: AgentState           // AgentState *after* applying the event with matching seq
}
```

**When to write**: implementation-defined. Reasonable policies:
- Every N events (`N=100`)
- After any turn-ending event (`finish` effect)
- On session pause / process shutdown

**Semantics**: A snapshot is a **shortcut**, not authoritative. If a snapshot and a re-fold disagree, the re-fold wins and the snapshot is stale (deletes are safe). Snapshots MAY be stored in a separate file (`sessions/snapshots/<sessionId>_<seq>.json`) instead of inline; either is valid.

### 2.5 Runtime metadata (kind: 'runtime_metadata')

Written by the host for runtime facts that matter for audit/debugging but do
not change reducer state and must not be folded during replay.

```ts
type RuntimeMetadataEntry = {
  kind: 'runtime_metadata'
  ts: string
  sessionId: string
  action: string
  payload: Record<string, unknown>
  artifactRef?: LogArtifactRef
}
```

Examples include `compaction_skipped`, `compaction_rejected`, and compaction attempt
reports. These action names are host metadata labels, not `AgentEvent.kind`
values.

---

## Tool Intention normalization

LLM-facing Tool schemas require `_intent`. On `llm_response`, the Kernel trims and
bounds that value, removes it from execution input, and persists it as
`tool_call.intent`. Pending calls, approval events, and `call_tool` effects may carry
`intent`; the Executor receives only the real Tool input. Missing legacy values stay
absent rather than being synthesized from commands, paths, or parameters.

---

## 3. Full example

A four-event session ("hi" → LLM tool call → tool result → LLM text reply):

```jsonl
{"kind":"header","seq":0,"ts":"2026-07-04T17:30:15.000Z","sessionId":"01J1XZ8T4W9F2A3B4C5D6E7F8G","formatVersion":1,"kernelVersion":"@agent-kernel/kernel@0.1.0","config":{"tools":[{"name":"read","description":"Read a file","inputSchema":{"type":"object"},"requiresApproval":false}],"systemPrompt":"You are a coding agent."},"initialState":{"sessionId":"01J1XZ8T4W9F2A3B4C5D6E7F8G","messages":[{"role":"system","content":[{"type":"text","text":"You are a coding agent."}]}],"pendingCalls":[],"status":"idle","usage":{"inputTokens":0,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0},"cursor":0}}
{"kind":"event","seq":1,"ts":"2026-07-04T17:30:15.412Z","event":{"kind":"user_message","text":"Read /tmp/notes.md"},"effects":[{"kind":"call_llm","messages":[...],"tools":[...]}]}
{"kind":"event","seq":2,"ts":"2026-07-04T17:30:17.891Z","event":{"kind":"llm_response","message":{"role":"assistant","content":[{"type":"tool_call","callId":"c1","name":"read","input":{"path":"/tmp/notes.md"},"intent":"Inspect the requested notes so their contents can be summarized accurately."}]},"usage":{"inputTokens":142,"outputTokens":38}},"effects":[{"kind":"call_tool","callId":"c1","name":"read","input":{"path":"/tmp/notes.md"},"intent":"Inspect the requested notes so their contents can be summarized accurately."}],"usage":{"inputTokens":142,"outputTokens":38,"cacheCreationTokens":0,"cacheReadTokens":0}}
{"kind":"event","seq":3,"ts":"2026-07-04T17:30:18.104Z","event":{"kind":"tool_result","callId":"c1","ok":true,"content":"# My notes\n..."},"effects":[{"kind":"call_llm","messages":[...],"tools":[...]}]}
{"kind":"event","seq":4,"ts":"2026-07-04T17:30:20.552Z","event":{"kind":"llm_response","message":{"role":"assistant","content":[{"type":"text","text":"The file contains your notes about..."}]},"usage":{"inputTokens":210,"outputTokens":56}},"effects":[{"kind":"finish"}],"usage":{"inputTokens":352,"outputTokens":94,"cacheCreationTokens":0,"cacheReadTokens":0}}
```

Reformatted for reading (real files are one-object-per-line):

```json
{
  "kind": "header",
  "seq": 0,
  "ts": "2026-07-04T17:30:15.000Z",
  "sessionId": "01J1XZ8T4W9F2A3B4C5D6E7F8G",
  "formatVersion": 1,
  "kernelVersion": "@agent-kernel/kernel@0.1.0",
  "config": { "tools": [...], "systemPrompt": "You are a coding agent." },
  "initialState": { "sessionId": "...", "messages": [...], "cursor": 0, ... }
}
```

---

## 4. Load / replay algorithm

Reconstructing the current state from a log:

```ts
function loadSession(path: string): { state: AgentState; config: AgentConfig } {
  const lines = readAllLines(path).filter(l => l.trim().length > 0)
  const parsed = lines.map((line, i) => {
    try { return JSON.parse(line) as LogEntry } catch (e) {
      if (i === lines.length - 1) return null           // tolerate corrupted tail
      throw new Error(`Line ${i+1} corrupted; log is not recoverable`)
    }
  }).filter(Boolean) as LogEntry[]

  if (parsed[0].kind !== 'header') throw new Error('First entry must be header')
  const { config, initialState } = parsed[0] as HeaderEntry
  const events = parsed.filter(e => e.kind === 'event') as EventEntry[]

  const finalState = fold(initialState, events.map(e => e.event), config)
  return { state: finalState, config }
}
```

### 4.1 Snapshot-accelerated replay

```ts
function loadSessionFast(path: string): ... {
  const parsed = readAndParse(path)
  const header = parsed[0] as HeaderEntry
  const events = parsed.filter(e => e.kind === 'event') as EventEntry[]
  const snapshots = parsed.filter(e => e.kind === 'snapshot') as SnapshotEntry[]

  const lastSnapshot = snapshots.at(-1)
  const startState = lastSnapshot ? lastSnapshot.state : header.initialState
  const startSeq = lastSnapshot ? lastSnapshot.seq : 0

  const tailEvents = events.filter(e => e.seq > startSeq).map(e => e.event)
  return { state: fold(startState, tailEvents, header.config), config: header.config }
}
```

### 4.2 Cursor consistency check (recommended)

After replay, verify:
- `finalState.cursor === max(seq of events in log)`
- If snapshots exist, each snapshot's state equals `fold(initialState, events[0..snapshot.seq], config)`

Both are cheap invariants that catch log corruption and kernel drift early.

### 4.3 Crash recovery

Load also patches sessions that were mid-turn when the host died:

- **Pending tool calls left in the log.** If the folded state ends in
  `awaiting_approval` or `executing_tools` with non-empty `pendingCalls`,
  the store appends a synthetic `user_approve` (for calls that were still
  awaiting) followed by a failed `tool_result` (`ok: false`,
  `content: 'host restarted while call was pending'`) for each pending
  call. These entries are appended to the same JSONL so replay stays
  deterministic.
- **Interrupted LLM streams.** If the folded state ends in `thinking`
  with no pending calls, the store appends an `llm_response` with body
  `[interrupted]`, moving the FSM to `done`.

Both fix-ups run once at load time. The persisted log is the durable
recovery artifact; there is no separate crash journal.

---

## 5. Fork semantics

Forking a session produces a **new file**, not an edit of the parent's file.

```
Parent log:  sessions/2026-07-04T10-00-00Z_p1.jsonl        (10 events)

Fork after event 3:

New log:     sessions/2026-07-05T11-00-00Z_p2.jsonl
             ├─ header { parentSessionId: 'p1', parentCursor: 3, initialState: <state after fold 3 events> }
             ├─ event seq=4 (new)
             ├─ event seq=5 (new)
             └─ ...
```

The new session's `header.initialState` is `fold(parent.initialState, parent.events[0..3], parent.config)`. The new session's `seq` counter continues from 4 (the number of events "carried over" plus 1). This preserves the invariant that `seq == state.cursor`.

**Kept properties**:
- Parent log is never mutated. Forking a shared parent from multiple branches is safe.
- Replaying the fork alone reproduces the fork's state (no need to walk parent → child)
- Because the fork's initial state is inlined into its header, parent logs can be archived or deleted without breaking the fork.

---

## 6. What is NOT in the log

The following are **not** persisted in the log, on purpose:

- **LLM raw request/response bytes.** Only the normalized `Message` is stored. If you need raw provider payloads for debugging, add a side-channel log.
- **Tool execution internals.** Only the `content` string and `ok` flag. What the tool did on disk is out of scope.
- **User's local secrets.** API keys, tokens, etc. must not be embedded in any event.
- **Effects that are host-only concerns.** Retries, backoff timers, and connection health are ephemeral.

If any of these turn out to be needed in v2, add a new kind: e.g. `{ kind: 'debug', ... }`. Existing consumers should skip unknown kinds gracefully (see §7).

---

## 7. Forward compatibility

Log readers MUST:
- Skip lines with unknown `kind` (log a warning, don't crash)
- Skip unknown fields within known kinds
- Refuse to load a log whose `header.formatVersion` is newer than the reader supports

Log writers MUST:
- Emit `header.formatVersion = 1` for v1
- Never delete fields (only add) within a formatVersion. Removing a field requires a version bump.

---

## 8. File size guardrails

There is no hard cap. But practical guidance:

| Volume | Behavior |
|---|---|
| < 10 MB | No optimization needed |
| 10–100 MB | Enable periodic snapshots (§2.3) |
| > 100 MB | Archive: move to `sessions/archive/`, keep a stub with a pointer for the dashboard's session list |

Log rotation across multiple files for a single logical session is **not** supported in v1.

---

## 9. Concurrent writers

There is exactly **one writer** per log file: the Host process that owns the session. If multiple Host replicas exist (v2), they MUST use a per-session lease so only one owns writes at a time.

Readers (dashboards, offline replay tools) MAY read the file concurrently with writing. Since the format is append-only, readers can watch for growth. They MUST handle the tail-partial-line case as described in §1.2.

---

## 10. Determinism guarantee

Given:
- Log file with header + events (no snapshots)
- Same `@agent-kernel/kernel` version as `header.kernelVersion`

Then `fold(header.initialState, events.map(e => e.event), header.config)` produces the **exact same** `AgentState` as the live session did.

This is the load-bearing property. If it breaks, either:
- The kernel is no longer pure (a bug in kernel)
- The log was tampered with
- The kernelVersion changed and introduced a semantic difference (must be a major bump)
