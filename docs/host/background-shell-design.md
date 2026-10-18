# Background Shell — Design v2

Status: implementation-in-progress
Owner: dashboard + executor
Related: [tools.md](../reference/executor/tools.md), [protocol/wire-protocol.md](../protocol/wire-protocol.md), [ARCHITECTURE.md](../architecture/overview.md)

## 1. What we already have

A minimum-viable background-shell stack shipped earlier:

- **Executor runtime** — `packages/executor/src/tools/background-shell.ts` spawns detached bash children, streams stdout/stderr into `${tmpdir}/.ak-tasks/<taskId>.log`, and keeps a `Map<taskId, BackgroundTask>` in memory.
- **Three built-in tools** the LLM can call — `bash` (with `run_in_background: true`), `bash_output`, `kill_shell` (packages/executor/src/tools/bash{,-output}.ts, kill-shell.ts).
- **Dashboard derivation** — `packages/dashboard/src/background-terminal.ts` reconstructs task state by scanning the timeline for tool_call/tool_result pairs; `BackgroundTerminalPanel` renders whatever the agent has *pulled* via `bash_output`.

This works for demo runs but has three real problems in day-to-day use:

1. **The dashboard only sees output the agent chose to fetch.** If the LLM never calls `bash_output`, the operator has no way to peek at a long-running server, even though the executor is happily buffering it to disk. The panel shows "task started" and nothing else.
2. **No live tail.** Output only advances when a new `tool_result` lands on the timeline, and the panel doesn't re-request. Watching a build is impossible.
3. **No operator kill button.** To stop a runaway task, the operator has to prompt the agent, who has to call `kill_shell` — a five-second detour when the right answer is one click.

## 2. Reference designs

### Claude Code

Claude Code's `Bash` tool exposes `run_in_background: true`, and the CLI shows a persistent status line:

```
● Running 2 background tasks · task 01H...ABC (npm run dev, 42s) · press b to view
```

Hitting `b` opens a full-terminal split with each task as a tab. Output tails automatically; `Ctrl-C` inside the tab issues `kill_shell` on the current task. The CLI polls the executor over its local IPC every ~500 ms.

Two shape decisions we're keeping:

- **Three tools, not one** — spawning, reading, and killing are separate. Keeps LLM prompts simple ("call bash_output when you need to check on the task") and gives the frontend three primitives to bind buttons to.
- **`taskId` is authoritative** — everything is keyed off it. The `callId` that created the task is a hint for navigation, not the identity.

### Codex CLI

Codex ships a `shell` tool that always runs in the foreground but has a `--background` prefix that returns immediately with a job number, mirroring the shell's `&`. Jobs are stored per-executor in a socket-file registry. The `jobs`, `fg`, `kill` subcommands round-trip through the same registry. Interesting bits:

- **Merge stdout/stderr into one interleaved stream by default.** That's how a human reads terminal output. Codex offers `--split` to separate them for scripting.
- **Bounded ring-buffer of the last N MiB.** Long tasks don't consume unbounded RAM/disk; older output is lost with a `[... 3.2 MiB truncated ...]` marker.

We're stealing both.

### opencode

opencode's approach is close to Claude Code's — three tools, in-memory registry, WS push for status changes. The one thing that stood out:

- **The push channel is separate from the tool-result stream.** The agent's timeline shows `tool_call(kill_shell) → tool_result(ok)`; the dashboard's status update comes over a `bg:task_updated` event. Rationale: tool_results are *ledger* entries (event log), whereas live status is *state* (queried on demand, pushed when it changes). Mixing them means every dashboard poll accretes another timeline row.

We're taking the same split.

## 3. Goals

1. **Session-scoped observability.** The dashboard shows every background task owned by the active session the moment the executor spawns it, whether or not the agent has called `bash_output` yet, and tails output live. Tasks from sibling sessions in the same workspace are not visible or controllable by default.
2. **One-click kill and copy.** No prompt-writing to interrupt a stuck task.
3. **Agent contract is unchanged.** The three-tool API (`bash{run_in_background}`, `bash_output`, `kill_shell`) and their JSON shapes stay identical — existing sessions, tests, and LLM prompts keep working.
4. **Fail-safe on replays.** When a session is opened from disk (executor dead), we still render whatever the timeline captured, degraded but correct.
5. **Bounded resource use.** Log files cap at 4 MiB per task, ring-buffered; task metadata evicted 15 minutes after exit.

Non-goals: pseudo-TTY (interactive prompts inside a bg task, e.g. sudo password), persistent tasks across executor restarts, cross-executor task migration. Any of those is a separate design.

## 4. Architecture

Three layers, each with a small, additive change.

```
┌──────────────┐   bg:list/bg:output/bg:kill (WS req/ack)   ┌──────────────┐
│  Dashboard   │ ◀───────────────────────────────────────▶ │     Host     │
│  BgPanel     │   bg:task_updated / bg:task_ended (push)  │              │
└──────────────┘                                            └──────┬───────┘
                                                                   │
                                                    same request/ack forwarded
                                                                   ▼
                                                          ┌────────────────┐
                                                          │    Executor    │
                                                          │ bg registry +  │
                                                          │ .ak-tasks/*.log│
                                                          └────────────────┘
```

Nothing goes through the kernel. Background-shell status is an **executor-local runtime observation**, not part of `AgentState`. This is deliberate: the kernel's log is the ledger of what the agent *did*; watching a `tail -f` isn't a state transition.

### 4.1 Executor changes

`packages/executor/src/tools/background-shell.ts` grows a proper registry API:

```ts
export type BackgroundTaskStatus = 'running' | 'exited' | 'killed' | 'signaled'

export type BackgroundTaskSummary = {
  taskId: string
  sessionId: string
  command: string
  cwd: string
  startedAt: string       // ISO
  endedAt?: string        // ISO, when status ≠ 'running'
  status: BackgroundTaskStatus
  exitCode: number | null // null iff still running or terminated by signal
  signal: string | null
  bytesLogged: number     // running counter, includes truncated bytes
  bytesTruncated: number  // bytes dropped when ring buffer wrapped
}

export function listBackgroundTasks(sessionId: string): readonly BackgroundTaskSummary[]
export function getBackgroundTask(taskId: string): BackgroundTaskSummary | null
export function readBackgroundShell(...): Promise<...>           // unchanged shape
export function killBackgroundShell(taskId: string, sessionId: string): Promise<boolean>
export function subscribeBackgroundTasks(cb: (change: BgTaskChange) => void): () => void
```

- The registry becomes an `EventEmitter` internally; `subscribeBackgroundTasks` returns an unsubscribe fn. Emitted on `spawn`, on `close` (exit/signal), and every ~500 ms while a task is producing new bytes (throttled).
- Log file gets a ring-buffer wrapper: writes past the 4 MiB high-water-mark rewrite from offset 0, and the summary tracks `bytesTruncated` so consumers know they're seeing a tail. Existing callers of `readBackgroundShell` continue to work — output is always the current buffer contents plus a `truncated` boolean.
- Task cleanup: 15 min after `endedAt`, drop from the map and unlink the log. The invariant: any `taskId` that ever appeared in a `tool_result` remains resolvable for at least 15 min after exit; older ones return `unknown`.

Because `bashTool` already calls `startBackgroundShell`, the tool changes reduce to passing the per-call `sessionId` from `ToolContext` and swapping the return shape from `{taskId, note}` to `{taskId, note, startedAt}` — additive, tolerated by every existing consumer.

### 4.2 Wire protocol additions

Added to `packages/shared/src/protocol.ts`. Style matches the existing `fs:list_files` / `fs:read_file` ack-based RPCs — dashboard → host → executor, ack flows back the same path.

```ts
// dashboard → host → executor (RPC, ack)
export type ClientListBgTasks = { requestId: string; workspaceId: string; sessionId: string }
export type BgListResult = {
  requestId: string
  workspaceId: string
  sessionId: string
  tasks: readonly BackgroundTaskSummary[]
  error?: string
}

export type ClientReadBgOutput = {
  requestId: string
  workspaceId: string
  sessionId: string
  taskId: string
  offset?: number         // byte offset in the current buffer
  maxBytes?: number       // cap on returned slice, default 64 KiB
}
export type BgOutputResult = {
  requestId: string
  workspaceId: string
  sessionId: string
  taskId: string
  content: string
  nextOffset: number
  done: boolean
  status: BackgroundTaskStatus
  bytesTruncated: number
  error?: string
}

export type ClientKillBgTask = { requestId: string; workspaceId: string; sessionId: string; taskId: string }
export type BgKillResult = {
  requestId: string
  workspaceId: string
  sessionId: string
  taskId: string
  killed: boolean
  error?: string
}

// executor → host → dashboard (push)
export type ServerBgTaskUpdated = {
  workspaceId: string
  sessionId: string
  task: BackgroundTaskSummary
  // included when a chunk of new output caused the update; empty otherwise
  delta?: { fromOffset: number; content: string }
}
```

Socket.IO event names:

- Dashboard emits `bg:list`, `bg:output`, `bg:kill` (all with ack).
- Executor emits `bg:task_updated` (push, no ack).
- Host relays the RPCs like it already does for `fs:*`, but validates that the requested `sessionId` is in the target `workspaceId`. Push events are rebroadcast to the owning `session:<sessionId>` room.

Rationale for carrying both `workspaceId` and `sessionId`: the process physically lives in the executor for a workspace, but ownership belongs to the session that spawned it. This lets multiple sessions share one executor without leaking task output or kill rights across sessions. Workspace-wide operator views can be added later as an explicit admin surface, not as the default session dashboard.

### 4.3 Host changes

`packages/host/src/connection/dashboard-ns.ts` grows three handlers that thin-forward to the executor (mirroring `fs:list_dirs`):

```ts
socket.on('bg:list', async (payload, ack) => {
  const executor = executors.forWorkspace(payload.workspaceId)
  if (!executor) return ack({ ...payload, tasks: [], error: 'no executor attached' })
  executor.emit('bg:list', payload, (result) => ack(result))
})
// bg:output, bg:kill: analogous
```

Push side: the executor namespace (`executor-ns.ts`) subscribes to the local registry when the executor announces, and forwards `bg:task_updated` events into a per-workspace socket room the dashboard is already subscribed to.

### 4.4 Dashboard changes

New hook `packages/dashboard/src/features/chat/useBackgroundTasks.ts`:

- On mount: emit `bg:list` for the current workspace and session.
- Listen for session-scoped `bg:task_updated` pushes and reduce into an in-memory `Map<taskId, BackgroundTaskSummary + tail>` keyed by taskId.
- Poll `bg:output` every 1.5 s for the *selected* task's tail — even when there's no push, that's the visible "tail" behavior. Push events short-circuit the wait (server told us there's new content, fetch immediately).
- Fall back to the existing `backgroundTerminalTasks(timeline)` derivation when there's no live executor (offline replay).

`BackgroundTerminalPanel` gets a rewrite:

- Compact footer control, similar to `TasksButton`: shows a one-line status ("2 running · npm run dev · 12 s") that expands into a popover/drawer.
- Drawer content: left column = task list (status dot, command, elapsed, kill button), right column = output pane with monospace, auto-scroll-to-bottom toggle, copy-all, restart hint.
- Selecting a task in the drawer sets it as the poll target; unselecting stops the poll (only push events keep the summary current).
- Kill button emits `bg:kill` and disables until the task's status flips.

Timeline stays untouched — the existing derivation is preserved as a fallback and drives the `Inspector.Tool Call` view. Nothing about how the agent sees the world changes.

## 5. Alternatives considered

- **Push everything, no polling.** Rejected. If a build produces 50 KB/s of output, that's 100 socket messages a second per open dashboard. Push is throttled to ~2 Hz per task; the dashboard polls for the *selected* task where the operator wants real-time, and lets the push tell it "there's more" for background tasks.
- **Kernel events for lifecycle.** Rejected. Would double the timeline size for tasks that stream heavily. The three-tool tool_result rows are already sufficient breadcrumbs; live status is dashboard-only concern.
- **Store logs in-memory only.** Rejected. `tail -f` on a 12-hour build would OOM the executor. Disk-backed ring buffer with a size cap is the right pressure valve.
- **Persist tasks across executor restart.** Rejected as a v2 goal. Executor restart already kills all children (they're `spawn`ed as its group); rebuilding the registry from `/tmp/.ak-tasks/*.log` would need a lockfile + reconciliation dance that doesn't earn its complexity here.

## 6. Roll-out & testing

- The additive wire messages ship together; a mixed dashboard/executor pair with only one side upgraded degrades cleanly: dashboard sees "no executor attached" errors from `bg:list` and falls back to timeline derivation.
- Executor keeps unit-test coverage on the registry (start, read, kill, cleanup, ring-buffer wrap).
- Dashboard adds a hook test with a stubbed socket and a panel snapshot test.
- Manual E2E: `run_in_background: true` on `yes | head -100000`, watch the panel tick, click kill, confirm the exit summary lands within ~1 s.
