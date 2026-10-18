# Architecture

**Status**: Normative for topology & responsibilities. Wire-level details live in [protocol/wire-protocol.md](../protocol/wire-protocol.md); kernel-level details in [SPEC.md](../reference/kernel/spec.md).

---

## 1. The three processes

`agent-kernel` deploys as **three cooperating processes**. All three can run on one machine for local development; in production the split matters.

```
   ┌────────────────────────────────────────────────────────────────┐
   │  DASHBOARD  (React SPA — static bundle served by Host)         │
   │    ─ Explorer (workspaces + sessions)                          │
   │    ─ Workbench (chat, inspector, replay, settings)             │
   └───────────────────────────┬────────────────────────────────────┘
                               │  Socket.IO (namespace: /dashboard)
                               ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  HOST  (Node.js, has public IP)                                │
   │                                                                │
   │    ┌──────────────────────┐   ┌──────────────────────┐         │
   │    │ Kernel               │   │ LLM Adapter          │         │
   │    │ (pure FSM step)      │   │ (Anthropic/OpenAI/…) │         │
   │    └──────────────────────┘   └──────────────────────┘         │
   │    ┌──────────────────────┐   ┌──────────────────────┐         │
   │    │ Host loop            │   │ Event log (JSONL)    │         │
   │    │ (consumes effects,   │   │  ~/.kala/    │         │
   │    │  dispatches events)  │   │   sessions/*.jsonl   │         │
   │    └──────────────────────┘   └──────────────────────┘         │
   │    ┌──────────────────────┐   ┌──────────────────────┐         │
   │    │ agent tool (builtin) │   │ Compaction driver    │         │
   │    │ spawns child JSONL   │   │ (manual + auto,      │         │
   │    │ session in workspace │   │  writes messages_replaced) │    │
   │    └──────────────────────┘   └──────────────────────┘         │
   │    ┌──────────────────────────────────────────────────┐        │
   │    │ Connection layer (Socket.IO server)              │        │
   │    │   namespaces:  /dashboard   /executor            │        │
   │    │   rooms:       session:<id>                      │        │
   │    │   routing key: workspaceId (session → executor)  │        │
   │    └──────────────────────────────────────────────────┘        │
   │    Also serves packages/dashboard/dist/ as static assets.      │
   └────────────────────────────┬───────────────────────────────────┘
                                │  Socket.IO (namespace: /executor)
                                │  ← executor dials OUT to host
                                ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  EXECUTOR (a WORKSPACE — the machine tools run on)             │
   │    ┌──────────────────────────────────────────────────┐        │
   │    │ Announce: workspaceId, workspaceName, os,        │        │
   │    │           runtime, sandboxRoots, tool names      │        │
   │    └──────────────────────────────────────────────────┘        │
   │    ┌──────────────────────────────────────────────────┐        │
   │    │ Tool registry: read / write / edit / bash /      │        │
   │    │                grep / glob / ls / memory /       │        │
   │    │                web_search /                      │        │
   │    │                bash_output / kill_shell          │        │
   │    └──────────────────────────────────────────────────┘        │
   │    ┌──────────────────────────────────────────────────┐        │
   │    │ Sandbox (working directory whitelist)            │        │
   │    │ Background shell registry (bash --run-in-bg)     │        │
   │    └──────────────────────────────────────────────────┘        │
   └────────────────────────────────────────────────────────────────┘
```

---

## 2. Process responsibilities

### 2.1 Kernel (library, not a process)

Lives inside Host as `@agent-kernel/kernel`. Pure function `step(state, event, config) → { next, effects }`. See [SPEC.md](../reference/kernel/spec.md).

**Not a process.** Do not deploy the kernel separately. It is a ~300 LOC pure-function library that Host imports.

### 2.2 Host

The only process with a **public IP** (or at least, reachable inbound by dashboard and executor).

**Responsibilities**:
- Own the kernel's `AgentState` for each active session (in-memory Map keyed by `sessionId`)
- Drive the FSM: pull events off an input queue, call `step`, dispatch resulting effects, feed responses back as events
- Talk to LLM providers via the LLM Adapter (translate `call_llm` effect → provider request → `llm_response` / `llm_error` event). Stream token deltas to the dashboard as `session:token_delta`; the JSONL log only records the final `llm_response`.
- Persist events to a JSONL log (append per `step` result). Recover on restart by folding the log and appending synthetic events for stuck pending tool calls / interrupted streams (see [event-log.md](../protocol/event-log.md) §4.3).
- Broadcast state and events to subscribed dashboards; dispatch `call_tool` effects to the executor announcing the session's `workspaceId` (i.e. the machine the session is bound to)
- Serve two Socket.IO namespaces: `/dashboard` and `/executor`, rooms `session:<id>`, and serve the pre-built Dashboard bundle from `packages/dashboard/dist/`
- Drive context compaction (both auto via host `ContextSnapshot.pressureLevel === 'hard'` and manual via `client:compact` / the `/compact` slash command). The summarizer is invoked with the LLM adapter; successful replacement is recorded as `messages_replaced(reason='compaction')`, while attempt metadata is written as runtime metadata/artifacts.
- Provide the host-side `agent` builtin tool: spawn a child JSONL session in the same workspace, inheriting the parent's `approvalMode`, and return the child's final assistant text.
- Compose optional Runtime capabilities through a startup-time `ExtensionRegistry`. Session modes, Host tools, maintenance operations, and Session, state-transition, turn, model, tool, cancellation, and recovery lifecycle contributors register once; duplicate capability ownership fails startup, and the registry is sealed before serving Sessions.
- Persist Runtime Unit state in one SQLite store: Memo records use revisioned transactions, while Search and Speech credentials are encrypted records protected by one external Unit master key. The master key is never stored in SQLite; Dedicated installations provision it at `/etc/kala/state-store.key`.
- Auto-import LLM providers/models from `~/.claude/settings.json` and `~/.codex/config.toml`, merge user-managed model ids from `~/.config/kala/models.json`, and expose sanitized snapshots to the dashboard via HTTP `GET /models` and `GET /settings`.

**Non-goals**:
- Does not implement tools directly (executor does)
- Does not know about specific providers deeply — the LLM Adapter abstracts them

### 2.3 Executor

Lives close to the files it needs to touch. Dials **out** to Host via Socket.IO. Never accepts inbound connections.

**One executor per workspace, one workspace per local profile.** The executor's `workspaceId` (a stable ULID persisted in `~/.kala/workspace-id`) is the routing key Host uses to dispatch tool calls; the `workspaceName` (defaults to `os.hostname()`) is the display label. Two executor processes with the same `workspaceId` are treated as replicas of the same workspace. A development machine can run an additional isolated executor with `--profile dev`, which stores its lock, `workspace-id`, and token under `~/.kala/profiles/dev/`.

**Two forms**:

1. **Local Node daemon**: user runs `node kala-executor.cjs --host wss://host.example.com`. Has access to a whitelisted working directory. Runs `bash`, `read`, `write`, etc. against the real filesystem. Also runs background shell tasks (see below).
2. **Browser WebContainer**: dashboard hosts an in-page executor via WebContainer API [1]. Same tool implementations, but the filesystem is an in-memory vfs. Enables the "demo with just a URL" experience.

**Responsibilities**:
- On connect, `announce` its capabilities: `workspaceId`, `workspaceName`, `os`, `runtime`, `runtimeVersion`, `hostname`, `sandboxRoots`, and the list of tool names implemented
- Wait for `call_tool` messages (each carrying an optional `cwd` copied from `state.cwd`), execute them against the sandbox, and reply with `tool_result` (ok + content)
- Serve directory listings for `fs:list_dirs` requests (used by the create-session Finder-style picker)
- Manage a per-executor background shell registry: `bash { run_in_background: true }` starts a task and returns `{ taskId, note }`; subsequent `bash_output` polls stream logs; `kill_shell` terminates. From the parent session's perspective these are just three normal tools — no new event kind is required.
- Handle `cancel` messages targeting a specific `callId`

**Non-goals**:
- No LLM knowledge
- No agent state
- No approval logic (approval happens in kernel via `request_approval` effect)

### 2.4 Dashboard

React SPA. Built to a static bundle (`packages/dashboard/dist/`) and served by Host — port 3000 is Host, not vite. Local `pnpm dev` still runs a vite dev server on 5288 for hot-reload during development, but the shipped experience is served from `dist`.

**Layout**:
- **Explorer** (left rail): a two-level tree of workspaces (announced executors) with their sessions grouped by time bucket. Each session row shows title, status, event count, and `currentCwd`. A workspace's Info icon opens the read-only workspace metadata dialog; a session's Info icon opens the session metadata dialog.
- **Workbench** (right): session toolbar (title, cwd editor, theme + inspector controls), chat transcript, composer (model picker, context usage ring based on `ModelInfo.contextWindow` / `AgentConfig.contextLimit`, send button, host status), and the Inspector / History / Settings / Approvals panels.
- **ActivityBar** (bottom): live runtime status, approval mode picker, permission banners.

**Responsibilities**:
- Connect to Host via Socket.IO (`/dashboard` namespace) with a `sessionId` and role
- Show the chat transcript (rendering text + image blocks), the inspector, the event timeline (with a compact boundary marker when `messages_replaced(reason='compaction')` fired), the replay/fork UI, the Settings pane (providers, models, approval mode default, host)
- Send user events (`user_message`, `user_approve`, `user_reject`, `cancel`) and control messages (`client:set_approval_mode`, `client:set_cwd`, `client:set_model`, `client:compact`, `client:rename_session`, `client:delete_session`, `client:create_session`, `client:list_dirs`) to Host

**Non-goals**:
- Never talks to Executor directly
- Never talks to LLM providers directly
- Never runs tool code

---

## 3. Turn lifecycle

The clearest way to understand the system is to trace one end-to-end turn.

**Scenario**: User asks "Read `/tmp/notes.md` and tell me what's in it."

### 3.1 Sequence diagram

```
Dashboard          Host (loop + kernel)               LLM               Executor
    │                        │                         │                    │
    │ ── user_message ─────► │                         │                    │
    │                        │ step(idle, user_message)                     │
    │                        │   → status: thinking                         │
    │                        │   → effect: call_llm                         │
    │ ◄─ state:thinking ──── │                                              │
    │                        │ ── request(messages, tools) ───────────────► │
    │                        │                                              │
    │                        │ ◄──── response(text? tool_calls?) ────────── │
    │                        │ step(thinking, llm_response)                 │
    │                        │   → append assistant msg (with tool_call)    │
    │                        │   → pending: [read/dispatched]               │
    │                        │   → status: executing_tools                  │
    │                        │   → effect: call_tool                        │
    │ ◄─ state:exec ──────── │                                              │
    │                        │ ── call_tool(read, {path: /tmp/notes.md}) ─────────────► │
    │                        │                                                          │
    │                        │ ◄─────────────── tool_result(ok, "…contents…") ───────── │
    │                        │ step(executing, tool_result)                 │
    │                        │   → append tool msg                          │
    │                        │   → pending: []                              │
    │                        │   → status: thinking                         │
    │                        │   → effect: call_llm                         │
    │ ◄─ state:thinking ──── │                                              │
    │                        │ ── request(messages incl. tool_result) ────► │
    │                        │                                              │
    │                        │ ◄──── response("The file says…") ─────────── │
    │                        │ step(thinking, llm_response)                 │
    │                        │   → append assistant msg (text only)         │
    │                        │   → status: done                             │
    │                        │   → effect: finish                           │
    │ ◄─ state:done ──────── │                                              │
```

### 3.2 Event log after this turn

The event log (see [event-log.md](../protocol/event-log.md)) records every `step` input. For the above turn:

```jsonl
{"seq":1,"ts":"...","event":{"kind":"user_message","text":"Read /tmp/notes.md and tell me what's in it."}}
{"seq":2,"ts":"...","event":{"kind":"llm_response","message":{"role":"assistant","content":[{"type":"tool_call","callId":"c1","name":"read","input":{"path":"/tmp/notes.md"}}]},"usage":{"inputTokens":142,"outputTokens":38}}}
{"seq":3,"ts":"...","event":{"kind":"tool_result","callId":"c1","ok":true,"content":"..."}}
{"seq":4,"ts":"...","event":{"kind":"llm_response","message":{"role":"assistant","content":[{"type":"text","text":"The file says…"}]},"usage":{"inputTokens":210,"outputTokens":56}}}
```

**Given these four events + the session's `AgentConfig`, `fold` reproduces the exact final state.** This is the replayability guarantee.

### 3.3 Adding an approval gate

If the user had asked "Delete `/tmp/notes.md`" and the `bash` tool has `requiresApproval: true`, the middle of the sequence becomes:

```
    │                        │ step(thinking, llm_response with tool_call bash)
    │                        │   → pending: [bash/awaiting_approval]
    │                        │   → status: awaiting_approval
    │                        │   → effect: request_approval
    │ ◄─ state:awaiting_approval + approval UI ─
    │
    │ ── user_approve ─────► │
    │                        │ step(awaiting_approval, user_approve)
    │                        │   → pending: [bash/dispatched]
    │                        │   → status: executing_tools
    │                        │   → effect: call_tool
    │                        │ ── call_tool(bash) ───────────────────► executor
```

`user_reject` is symmetric but synthesizes a `tool_result(ok=false, content=reason)` and skips the executor round-trip.

---

## 4. Data flow patterns

### 4.1 Effects are commands, events are facts

- **Effect** (`call_llm`, `call_tool`, `request_approval`, `finish`, `emit_error`): kernel says "I need this to happen".
- **Event** (`llm_response`, `tool_result`, `user_approve`, `user_reject`): host says "this happened".

Every effect that changes downstream state produces at least one event that feeds back into the kernel. Effects that don't produce events (`finish`, `emit_error`) are pure notifications — nothing else to do.

### 4.2 Broadcast vs. dispatch

- **Broadcast to Dashboard** (`state:changed`, `event:appended`): Host pushes state updates to all dashboards subscribed to a session. One-to-many.
- **Dispatch to Executor** (`call_tool`, `cancel`): Host sends to exactly one executor for the session. Uses Socket.IO ACK to correlate the response with the `callId`.

### 4.3 One workspace per session

A session is bound to exactly one workspace (i.e. one executor / one machine) at create time. All of that session's `call_tool` effects route to the executor announcing the same `workspaceId`. Sessions whose workspace has no attached executor appear offline in the Explorer but their logs remain readable. Multi-executor per session (routing different tool names to different machines) is intentionally out of scope — running tools across machines within a single turn is a distributed-system problem the kernel does not want to own.

### 4.4 Core boundary principle

The core design rule is broader than "use React hooks" or any one framework mechanism:

**Core mechanisms describe domain state and legal transitions. Peripheral mechanisms observe those transitions and perform environment-specific side effects.**

In practice:

- The Kernel / reducer owns `AgentState`, legal events, deterministic state transitions, and declarative effects. It must not call browser, filesystem, network, time, random, notification, audio, telemetry, or UI APIs.
- The Host loop owns effect dispatch and external IO. It translates kernel effects into LLM calls, executor calls, approval broadcasts, compaction work, hooks, recovery events, and persisted log entries.
- Dashboard state derivation should stay separate from browser side effects. Browser notifications, notification sounds, toasts, keyboard shortcuts, localStorage preferences, URL synchronization, focus management, and analytics-style observers belong in hooks, services, middleware, adapters, or equivalent boundary modules.
- UI components should render state and emit user intent. They should not become hidden state machines for agent protocol semantics.
- Integration adapters isolate unstable APIs. A browser API such as `Notification` / `AudioContext`, a provider API, a Socket.IO namespace, or a filesystem call should have a narrow wrapper so the core logic can be tested without that environment.

Acceptable boundary mechanisms include hooks, observer/subscriber layers, effect handlers, middleware, actor services, plugin systems, command handlers, and small adapter modules. The exact mechanism is less important than the dependency direction: **core emits facts or declarative commands; outer layers react. Outer-layer convenience must not expand the core state machine.**

Examples:

- "The session has a pending approval" is core state; "show a toast", "send a desktop notification", and "play a sound" are dashboard effects.
- "The reducer emitted `call_tool` with `cwd=/tmp`" is kernel output; "send that request to the matching executor and enforce sandbox roots" is host/executor responsibility.
- "Context pressure is hard" is host `ContextSnapshot` state; "run a summarizer and append `messages_replaced`" is host orchestration.
- "A provider HTTP request/response was captured" is trace metadata next to the event log; it is not an `AgentState` field and not a kernel event.

This principle is a review gate. When a feature adds state, first ask whether it changes the agent protocol itself or whether it is an observer of protocol state. Observers must be implemented outside the core mechanism and tested at the lowest layer that owns the side effect.

---

## 5. Failure modes and recovery

| What fails | Detection | Recovery |
|---|---|---|
| LLM API returns 5xx / timeout | LLM Adapter | Emit `llm_error` event → kernel → `error` status. Host may replace state (retry policy is host-owned) |
| Tool execution throws | Executor | Reply with `tool_result(ok=false, content=<error>)`. Kernel treats as normal tool result |
| Executor disconnects mid-call | Socket.IO ACK timeout | Host synthesizes `tool_result(ok=false, content="executor disconnected")` |
| Dashboard disconnects | Socket.IO reconnect | On reconnect, Host sends the full current state + a stream of events since last-seen `cursor` |
| Host crashes mid-turn | External (systemd / process manager) | Restart. Load rebuilds state from JSONL, then appends synthetic `user_approve` + failed `tool_result` for pending tool calls, or an `[interrupted]` `llm_response` for stuck LLM streams — see [event-log.md](../protocol/event-log.md) §4.3 |
| Kernel bug | Would surface as an invariant violation in tests | Fix, ship, replay is safe because event log is unchanged |

**Guarantee**: as long as the event log survives, the session survives. Nothing else is authoritative.

---

## 6. Storage model

### 6.1 Sessions on disk

```
~/.kala/
├── config.json                        # user config: default provider, tokens, executor URL
└── sessions/
    ├── 2026-07-04T17-30-15_s1.jsonl   # per-session event log
    ├── 2026-07-04T18-01-02_s2.jsonl
    └── snapshots/
        └── s1_cursor_100.json         # optional state snapshots for fast replay
```

**Naming**: `<iso-timestamp>_<sessionId>.jsonl`. Sortable by creation time. Session IDs are host-generated ULIDs.

**Snapshots**: purely a performance optimization. A snapshot is a JSON dump of `AgentState` at a given cursor. Replay can start from the nearest snapshot instead of the beginning of the log. Deleting snapshots is always safe.

### 6.2 What's in memory

Host keeps a `Map<sessionId, { state: AgentState, config: AgentConfig }>` for active sessions. Inactive sessions may be evicted; a fresh `user_message` triggers a load-from-log.

---

## 7. Local vs cloud deployment

The topology is the same. What changes is **who has the public IP**.

**Local dev** (everything on your laptop):
- Host listens on `localhost:3000` and serves the dashboard bundle from `packages/dashboard/dist/`
- Executor connects to `ws://localhost:3000/executor`
- User browses to `http://localhost:3000` — Host serves both the SPA and the `/socket.io` endpoint
- For dashboard development, `pnpm --filter dashboard dev` starts vite on 5288 with hot-reload; production behavior is `dist`-served on 3000
- One `pnpm dev` builds everything, starts Host, and attaches a local executor

**Cloud + local executor** (the differentiating deployment):
- Host deployed to Fly.io / Railway, reachable at `wss://host.example.com`
- Executor runs on your laptop, dials out: `node kala-executor.cjs --host wss://host.example.com --sandbox-root /repo`
- Dashboard hosted static (Vercel), served at `https://app.example.com`, connects to `wss://host.example.com/dashboard`
- The laptop needs **no inbound port**. It creates the outbound WS. This is the NAT/firewall workaround baked in.

**Full cloud** (demo with just a URL):
- Host + Dashboard as above
- Executor runs in the browser via WebContainer, no local install
- Only meaningful for demos / disposable sandboxes

---

## 8. Design decisions cross-reference

Every non-obvious topology choice above has an ADR:

| Choice | ADR |
|---|---|
| Kernel as pure reducer | [ADR 0001](adr/0001-pure-reducer.md) |
| Executor dials out to Host (reverse-WS) | [ADR 0002](adr/0002-reverse-websocket.md) |
| Socket.IO over raw WS / gRPC / SSE | [ADR 0003](adr/0003-socket-io.md) |
| Config separated from state | [ADR 0004](adr/0004-config-state-separation.md) |
| Planning / memory / subagents outside kernel | [ADR 0005](adr/0005-kernel-boundary.md) |
| No independent relay process in v1 | [ADR 0006](adr/0006-no-relay-process.md) |
| MCP-compatible tool schemas | [ADR 0007](adr/0007-mcp-compatible-tools.md) |
| Dashboard: Vite + React SPA | [ADR 0008](adr/0008-dashboard-vite-react.md) |
| Provider adapter strategy (Anthropic / OpenAI compat) | [ADR 0009](adr/0009-provider-adapter-strategy.md) |
| FSM dispatch table shape | [ADR 0010](adr/0010-fsm-dispatch-table.md) |
| Naming: Host + Kernel (was Server + Core) | [ADR 0011](adr/0011-rename-host-and-core.md) |
| Dashboard Finder-style layout + control-plane events | [ADR 0013](adr/0013-dashboard-finder-layout.md) |

## References

[1] https://webcontainers.io/
