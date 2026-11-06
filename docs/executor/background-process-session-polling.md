# Background Process Registry, `yield_time_ms` Auto-Backgrounding & Interactive `process` Tool

**Status:** Source of Truth (SoT)
**Scope:** `packages/executor`, `packages/host`
**Deployment Coverage:** Portable (in-process/local Executor), Dedicated (remote WebSocket Executor), Private Cloud (multi-replica Host + remote Executor with lease fencing)

---

## 1. Problem Statement & Motivation

Agents frequently execute commands whose runtime characteristics are either long-lived (dev servers, watchers, database containers), unpredictably slow (large test suites, builds), or interactive (CLI wizards, REPLs, prompts awaiting confirmation):

1. **Foreground Timeout vs. Blind Backgrounding**: Previously, an Agent had to choose upfront between `run_in_background: false` (which blocks the turn and kills the process on timeout) and `run_in_background: true` (which forces an extra round-trip `bash_output` call even for a command that finishes in 50ms).
2. **No Interactive `stdin` Channel**: Background tasks were spawned with `stdio: ['ignore', 'pipe', 'pipe']`. If a background process prompted for input (`y/N`, REPL expression, debugger command), the Agent had no mechanism to write to its `stdin`.
3. **Fragmented Lifecycle Management**: Listing active background tasks for a session, polling output with incremental offsets, sending `stdin`, and sending signals (`SIGTERM`, `SIGKILL`, `SIGINT`) were not unified under a single ergonomic tool schema (`process`).
4. **Remote Executor Ack Timeouts**: In Dedicated and Private Cloud deployments where Host and Executor communicate over Socket.IO, blocking polls or yield windows require coordinated Socket.IO acknowledgement timeouts (`ackTimeoutMsFor`) and session-ownership lease checks (`assertSessionEffectOwner`).

---

## 2. Architecture & Multi-Deployment Design

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Host (Portable / Dedicated / Private Cloud)                             │
│  - shellToolset: shell (with yield_time_ms), process (list/poll/write/  │
│    kill), bash_output, kill_shell                                       │
│  - connection/executor.ts:                                              │
│      * assertSessionEffectOwner(sessionId) before remote dispatch       │
│      * ackTimeoutMsFor('process' | 'shell' | 'bash')                    │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ Socket.IO tool:call (ctx.sessionId)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Executor (`packages/executor/src/tools/`)                               │
│  - bash.ts (`shell` / `bash`):                                          │
│      * Foreground execution (default)                                   │
│      * Explicit `run_in_background: true`                               │
│      * `yield_time_ms`: runs up to yield_time_ms; returns normal        │
│        foreground result if exited, or auto-transitions to background   │
│        with `{ status: "running", yielded: true, taskId, output, ... }` │
│  - process.ts (`process` tool):                                         │
│      * `action: "list"`  -> listBackgroundTasks(ctx.sessionId)          │
│      * `action: "poll"`  -> readBackgroundShell({ taskId, sessionId,    │
│                             offset, block, timeoutMs })                 │
│      * `action: "write"` -> writeBackgroundShell({ taskId, sessionId,   │
│                             input, eof })                               │
│      * `action: "kill"`  -> killBackgroundShell(taskId, sessionId, sig) │
│  - background-shell.ts:                                                 │
│      * `stdio: ['pipe', 'pipe', 'pipe']` with EPIPE guard               │
│      * Serialized per-task disk ring-buffer write queue (`writeChain`)  │
│      * Session-scoped isolation (`task.sessionId === ctx.sessionId`)    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Deployment Mode Guarantees

| Deployment Mode | How `shell(yield_time_ms)` & `process` Operate |
|---|---|
| **Portable Mode** | Runs directly in the local Executor bound to the workspace. Session IDs isolate concurrent sessions sharing the local Executor. |
| **Dedicated Mode** | Host dispatches `shell` and `process` over Socket.IO to the workspace's attached Executor. `ackTimeoutMsFor` extends the Socket.IO ack deadline for `process(action="poll", block=true, timeout_ms=...)` and `shell(yield_time_ms=...)` so blocking polls never trigger false `tool call acknowledgement timed out` errors. |
| **Private Cloud Mode** | Before dispatching `shell` or `process` to the attached Executor, `ExecutorRegistry.callTool` verifies `await resolver.assertSessionEffectOwner(sessionId)` against `PostgresSessionAuthority` / `SqliteSessionAuthority`. All background tasks on the Executor are keyed and filtered by `ctx.sessionId`, preventing cross-session data leakage on multi-session Executors. |

---

## 3. Detailed Specifications

### 3.1 `shell` / `bash` `yield_time_ms` Auto-Backgrounding

When `yield_time_ms` (integer $\ge 50$) is passed to `shell` / `bash` (and `run_in_background` is not `true`):
1. The command is spawned via `startBackgroundShell` with `stdio: ['pipe', 'pipe', 'pipe']` and its output is captured in the per-task ring buffer from byte `0`.
2. The tool awaits process exit, `ctx.signal` abort, or `yield_time_ms` (shortened only if an explicit foreground timeout is smaller). The ordinary foreground default timeout of 30 seconds does not apply to a yielded call. `capture_separate_streams` cannot be combined with `yield_time_ms`; an invalid combination is rejected.
   - **Process exits within the window**: The tool flushes the write queue, reads at most 1,000,000 bytes, cleans up the transient background task entry (`evictBackgroundShellNow`), and returns foreground output (`<output>--- exit code: <code>, duration: <ms>ms`). When there is more output it includes an explicit truncation marker.
   - **Process is still running after `yield_time_ms`**: The task remains in the background registry and the tool returns:
     ```json
     {
       "status": "running",
       "yielded": true,
       "taskId": "01J...",
       "pid": 42100,
       "output": "...",
       "nextOffset": 128,
       "bytesTruncated": 0,
       "note": "Command exceeded yield_time_ms and continues in the background. Use process (poll/write/kill) or bash_output with taskId."
     }
     ```
   - **Foreground timeout shorter than the yield window or caller abort**: The process group is signaled and a `--- killed after ... (timeout)` or `--- aborted` marker is returned. If termination cannot be confirmed within one second, its `taskId` remains available for inspection rather than silently discarding an active process.

For explicit `run_in_background: true`, cancellation before spawn fails with `ECANCELED`. Cancellation immediately after spawn also fails with `ECANCELED`: the Executor attempts tree termination, waits up to one second for confirmation, and includes the `taskId` in the error and retains it in the registry if termination is unconfirmed. A cancelled launch must not be interpreted as a successful start or as proof its side effects were undone.

### 3.2 `process` Tool Contract

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | `'list' \| 'poll' \| 'write' \| 'kill'` | Yes | Operation to perform on session background processes. |
| `task_id` | `string` | For `poll`/`write`/`kill` | Background task ID returned by `shell` (`run_in_background` or `yield_time_ms`). |
| `offset` | `integer >= 0` | No (`poll`) | Byte offset returned as `nextOffset` by a previous poll. Defaults to `0`. |
| `block` | `boolean` | No (`poll`) | Wait up to `timeout_ms` for new output or process exit before returning. |
| `timeout_ms` | `integer (1..300000)` | No (`poll`) | Maximum wait duration in milliseconds when `block=true` (default `30000`). |
| `input` | `string` | No (`write`) | UTF-8 string to write to the running process's `stdin` (include `\n` for line submission). |
| `eof` | `boolean` | No (`write`) | Close `stdin` (`EOF`) after writing `input`. |
| `signal` | `'SIGTERM' \| 'SIGKILL' \| 'SIGINT'` | No (`kill`) | Termination signal to send to the background process group (default `'SIGTERM'`). |

`poll` returns at most 1,000,000 bytes per response; `nextOffset` advances only over returned bytes, and `hasMore` indicates unread output even when `done=true` (the process has exited). Continue polling until `hasMore=false`. `ctx.signal` interrupts a blocked poll with `ECANCELED` rather than returning a successful poll response; it does not kill the process. Concurrent `write` operations are serialized so EOF cannot overtake preceding input. If cancellation occurs during an asynchronous `write` or `kill`, the tool fails with `ECANCELED`, includes `taskId`, and treats the effect outcome as unknown rather than returning a success-shaped response. Errors for unknown task IDs do not reveal whether another session owns the ID.

The Host classifies `process` as requiring shell approval: its `write` and `kill` actions have effects comparable to shell commands, so they must not inherit the read-only approval policy of `bash_output`.

### 3.3 Serialized Write Queue & Smart `poll` Blocking

- Each background task maintains `writeChain: Promise<void>` so every `stdout`/`stderr` data chunk is appended to the ring buffer sequentially without file-truncation races, and `readBackgroundShell` awaits `task.writeChain` before reading.
- Output logs live in a randomly named per-process temporary directory (mode `0700` on POSIX); each new log is exclusive and mode `0600`. The Executor process is responsible for protecting its own UID and temporary root; hard crashes can leave private log files for operator cleanup.
- A failed ring-buffer append, truncation, or rewrite marks the task with a persistent `outputError`, wakes blocked polls, and causes subsequent reads to fail with the task ID and an explicit output-unavailable error; log read failures also fail rather than returning empty content. `process(action="list")` exposes `outputError` for diagnosis. Eviction refuses running tasks and waits for pending log writes after close; if termination remains unconfirmed, the task ID remains available for inspection.
- In `process(action="poll", block=true)`:
  - If the caller supplies `wait_for_output: true` (default in `process(action="poll")`) and new bytes are already available beyond `offset` (`task.bytesLogged > offset`), `poll` returns the new output immediately; otherwise it waits up to `timeout_ms` for either new output or process exit.

### 3.4 Lifecycle and Security Boundaries

The registry is process-local, not a durable job store. The same Executor process retains task IDs across Host disconnect/reconnect and redispatched calls are deduplicated by the Executor's receipt/in-flight machinery; a different Executor process cannot recover their output or stdin. The Host checks session effect ownership before dispatch (and again on reconnect), while the Executor compares the task's session ID for every operation. This isolation assumes Host-authenticated tool dispatch: the Executor does not authenticate independently supplied session IDs. Tool acknowledgement timeout is an *indeterminate outcome*, not evidence a process stopped.

POSIX children use detached process groups for tree signaling. A hard Executor crash/restart does **not** reliably kill detached descendants; orphan cleanup requires an external supervisor or OS containment and remains a deployment limitation. On Windows `taskkill /T /F` is forceful regardless of the requested signal. On both platforms `kill` refuses to target a group/PID after its direct child has exited (PID reuse safety); descendants holding inherited pipes after shell exit may need external cleanup. The direct-child check does not eliminate the small exit-to-signal race; robust PID-reuse protection requires OS process handles or containment. Tasks are evicted 15 minutes after `close`, not while they are still running; a persistent process needs explicit termination. The ring buffer keeps at most 4 MiB of output; older offsets can no longer be replayed and UTF-8 bytes split at response boundaries may display replacement characters.

---

## 4. Verification & Acceptance Criteria

1. `shell` with `yield_time_ms` returns normal foreground output when the command finishes before `yield_time_ms`, and auto-backgrounds with `yielded: true` and `taskId` when the command exceeds `yield_time_ms`.
2. `process(action="write")` sends interactive `stdin` lines and optional `eof` to a running background process, and `process(action="poll", block=true)` receives the interactive reply immediately.
3. `process(action="list")` and `process(action="kill", signal="SIGKILL" | "SIGTERM")` manage session-scoped processes and reject cross-session `task_id` access.
4. `ExecutorRegistry` (`packages/host/src/connection/executor.ts`) computes extended ack timeouts for blocking `process(action="poll", block=true)` and `shell(yield_time_ms)` calls and enforces `assertSessionEffectOwner`.
