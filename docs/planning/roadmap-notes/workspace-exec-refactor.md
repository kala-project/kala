# Roadmap · Workspace-observation RPC refactor

**Status**: Design approved, unimplemented.
**Owner**: TBD
**Prereq reading**: [../../meta/principles.md](../../standards/engineering/principles.md), [../../executor/tools.md](../../reference/executor/tools.md), `packages/executor/src/tools/internal.ts` header comment.

---

## Problem

The dashboard needs to observe workspace state — git status, git diff, directory listings, file contents, background-task lists. Today each observation feature is implemented as **four coordinated pieces** across four packages:

```
shared/    ClientGitStatus + GitStatusResult zod schemas
host/      socket.on('git:status') + executors.gitStatus() forwarder
executor/  __git_status tool + git-handlers.ts (~200 lines of porcelain parsing)
dashboard/ requestGitStatus() + <SourceControlPanel>
```

Adding a new observation feature (say, an `npm outdated` panel) means editing all four. Deploying an executor without the matching host/dashboard causes `EINVAL: unknown tool: __git_status` at runtime — an actual production symptom that motivated this note.

The root cause is that **the executor "knows domains"**: `git-handlers.ts` embeds git's porcelain v2 grammar, `bg-handlers.ts` embeds the background-shell schema, and so on. The executor is supposed to be a generic workspace runtime; every domain-specific handler it carries binds its release cadence to whichever dashboard feature happens to use it.

The `__` internal-tool convention (see `internal.ts` header) was introduced to "collapse the executor's inbound wire surface" — but that only landed on the executor side. On the host side we still add a bespoke `socket.on('git:status')` per feature, so we pay the coupling cost twice.

## Non-goals

- No change to the agent-facing tool surface (`read`, `bash`, etc. per [tools.md](../../reference/executor/tools.md)). LLM-visible tools are governed by the "intersection of leading agents" principle and are out of scope.
- No change to overflow spill management (`__fs_read_overflow` etc.). Overflow is an executor-owned mechanism, not a generic observation feature.
- No change to pty/terminal channels (`terminal:create` etc.). PTY needs a dedicated bi-directional channel, not command execution.

## Design

Replace the per-feature RPC pattern with **one generic command-execution channel** plus **one binary-read channel**. All domain parsing (porcelain v2, ls output, bg task list) moves to the dashboard where it belongs — next to the components that render it.

### Wire protocol additions

Two new dashboard→host→executor RPCs. Both are dashboard-initiated observation, invisible to the LLM, do not enter transcripts, do go through the audit log.

**`workspace:exec`**

```ts
// request
{
  requestId: string
  workspaceId: string
  cwd?: string            // resolved against workspace root; must stay inside sandbox
  argv: string[]          // e.g. ['git', 'status', '--porcelain=v2', '-z']
  timeoutMs?: number      // default 15_000; hard ceiling 60_000
  stdin?: string          // for the occasional `git apply` etc.
  maxOutputBytes?: number // default 10 * 1024 * 1024
}

// response
{
  requestId: string
  stdout: string
  stderr: string
  exitCode: number | null // null when killed by signal / timeout
  durationMs: number
  truncated?: { stdoutBytes: number; stderrBytes: number }
  error?: { code: 'EACCES' | 'ENOENT' | 'ETIMEDOUT' | 'EINVAL'; message: string }
}
```

**`workspace:read_binary`**

```ts
// request
{
  requestId: string
  workspaceId: string
  path: string
  maxBytes?: number       // default 5 * 1024 * 1024
}

// response
{
  requestId: string
  base64: string
  mime: string            // sniffed via magic bytes
  size: number
  truncated?: { maxBytes: number }
  error?: { code: string; message: string }
}
```

`read_binary` is the one **admitted exception** to "no domain knowledge in the executor". The exception is defensible because it crosses the text-vs-binary boundary, which browsers cannot straddle from stdout alone.

### Architecture after the refactor

```
Dashboard                         Host                            Executor
─────────                         ────                            ────────
SourceControlPanel                                                workspaceExec(argv, cwd)
├─ parsePorcelainV2()  ─ws:exec ─►  socket.on('workspace:exec')     ├─ sandbox.checkCwd()
└─ parseGitDiff()      ─ws:exec ─►     │                            ├─ spawn(argv[0], argv.slice(1))
                                       ├─ audit.log()               └─ { stdout, stderr, exitCode }
FileExplorer           ─ws:exec ─►     └─ executors.workspaceExec()
├─ parseLs()
                                                                    readBinary(path)
FileViewer                                                          ├─ sandbox.checkPath()
└─ (binary preview)    ─ws:read_binary─►  socket.on('workspace:     ├─ readFile + mime sniff
                                              read_binary')         └─ { base64, mime, size }

BgTerminalPanel        (uses existing bash / bash_output / kill_shell tools — no new channel)
```

**Invariants**:

- Executor imports zero domain libraries beyond Node builtins. No `git-handlers.ts`, no `bg-handlers.ts`.
- Adding a dashboard observation feature edits **one package** (dashboard). Host, shared, executor untouched.
- Executor deployment cadence decouples from dashboard feature cadence. A dashboard version bump never causes `unknown tool` on a stable executor.
- Every dashboard observation RPC reaches a visible terminal state. Subscription
  failure, disconnect, malformed acknowledgement, thrown transport error, and
  acknowledgement timeout must resolve as an error; a file viewer must never
  remain in `Loading file` indefinitely. File-target changes use request
  generations so a late response cannot replace the currently selected file.
- File preview editors and language workers are release-owned Dashboard assets;
  production must not depend on a public Monaco CDN.

### Trust and audit

`workspace:exec` has the **same trust level as the agent-facing `bash` tool** — both run arbitrary commands inside the workspace sandbox. The difference is the actor: `bash` is initiated by the LLM (goes through approval when `approvalMode !== 'auto'`, enters transcript), `workspace:exec` is initiated by the human at a dashboard button (no approval, no transcript, but audit-logged). Same sandbox rules, same `sandbox.resolve()` cwd check, same output caps.

Every `workspace:exec` call produces one audit entry:

```
{ action: 'workspace.exec', actor, workspaceId, argv: argv.slice(0, 3), exitCode, durationMs }
```

`argv.slice(0, 3)` gives enough forensic context (`['git', 'status', '--porcelain=v2']`) without unbounded metadata.

## Migration plan

Four commits, each independently deployable. Old channels stay live until the dashboard is fully switched.

**Commit 1 — Executor gains new capabilities**
- Add `packages/executor/src/workspace-exec.ts` and `read-binary.ts` with tests.
- Register them as `__workspace_exec` / `__workspace_read_binary` internal tools.
- Existing `__git_*` / `__fs_*` / `__bg_*` untouched.
- Deploy executor. Safe: adds surface, removes nothing.

**Commit 2 — Host exposes new sockets**
- Add `socket.on('workspace:exec')` and `socket.on('workspace:read_binary')` in `dashboard-ns.ts`, ~15 lines each, pure forward + audit.
- Add `executors.workspaceExec()` / `readBinary()` in `executor.ts`.
- Old sockets untouched.
- Deploy host.

**Commit 3 — Dashboard switches**
- New helpers `packages/dashboard/src/lib/workspace-exec.ts` and `git-parser.ts`.
- `SourceControlPanel`, `FileExplorer`, `FileViewer` rewritten to use the new channels.
- Porcelain parser + tests migrate from `packages/executor/src/git-handlers.test.ts` to `packages/dashboard/src/lib/git-parser.test.ts` (same fixtures, same assertions — the parser is a pure function of stdout).
- Deploy dashboard. Manual verification: git panel, file tree, binary preview all still work.

**Commit 4 — Removal**
- Delete `git-handlers.ts` entirely.
- Delete the `readWorkspaceFile` codepath from `fs-handlers.ts` (list/search stay — see note below).
- Delete `__git_status`, `__git_diff`, `__fs_read_file` from `tools/internal.ts`.
- Delete `git:*` and `client:read_file` sockets from `dashboard-ns.ts`.
- Delete corresponding methods on `executors` in `executor.ts`.
- Delete per-feature zod schemas and TypeScript types for the removed endpoints from `shared`.
- Deploy host + executor. Any stale dashboard still on old sockets breaks visibly at this point — that is the intended forcing function.

**bg-handlers.ts is intentionally kept.** The bg feature holds a stateful
per-executor process registry (see `tools/background-shell.ts`); replacing
it with dashboard-initiated `workspace:exec` would require moving that
registry to the dashboard, which is not feasible for a browser client.
BgTerminalPanel continues to use the existing `bg:list` / `bg:output` /
`bg:kill` sockets against `__bg_list` / `__bg_output` / `__bg_kill`.

**`__fs_list_dirs` and `__fs_list_files` are also kept.** The directory
picker walks a single level (cheap) and the workspace file search does a
recursive walk with a skip-list of build directories — both would be
expensive to shell out for from the dashboard (each open, spawn a `find`
or repeated `ls`) and the executor-side implementation is already only a
few dozen lines. Only `__fs_read_file` migrates to
`workspace:read_binary` — reading a file is exactly what the new binary
channel exists for.

## Size estimate

| Package | Delete | Add | Net |
|---|---:|---:|---:|
| `executor/` | ~500 | ~150 | −350 |
| `host/` | ~200 | ~30 | −170 |
| `shared/` | ~200 | ~40 | −160 |
| `dashboard/` | ~50 | ~250 | +200 |
| **Total** | | | **≈ −480** |

Files touched: ~15. No new abstractions introduced (no "provider registry" or similar); the change is subtractive plus one generic RPC.

## Alternatives considered

**B — Executor-side provider registry** (`workspace:query { kind: 'git.status' }`). Rejected: still keeps `git-handlers.ts` in the executor, still requires editing two packages per new feature, and adds a "provider registry" abstraction whose only consumer is the dashboard — violates `principles.md` D2 ("no premature abstraction"). Would only be considered if some observation genuinely required executor-side code, which none currently does.

**C — Delete git tools only, leave `__fs_*` / `__bg_*`**. Rejected: leaves the dashboard with two incoherent architectural styles (git through generic exec, fs/bg through bespoke sockets) with no defensible reason. Debt moved, not paid.

## Acceptance

- `rg -n '__git_' packages/executor/src` returns empty.
- `rg -n 'readWorkspaceFile' packages/executor/src` returns empty.
- `rg -n "socket.on\('git:\|socket.on\('client:read_file" packages/host/src` returns empty.
- `__bg_*` / `bg:*` and `__fs_list_dirs` / `__fs_list_files` / `client:list_dirs` / `client:list_files` are intentionally retained; see the note under commit 4.
- SourceControlPanel, FileExplorer, FileViewer, binary preview all pass their existing e2e coverage using the new channels.
- Redeploying dashboard without redeploying executor works: no `unknown tool` at runtime.
- Audit log shows one entry per dashboard-initiated workspace command with `action: 'workspace.exec'`.

## Principles binding

- **§0 tool intersection**: agent-facing tools remain the leading-agent intersection. Dashboard-initiated observation is not a tool set and does not violate this principle.
- **D2 no premature abstraction**: the refactor is subtractive. The one generic channel replaces N specific channels; no new registry / plugin / adapter is introduced.
- **D5 cross-cutting at the host boundary**: dashboard observation is exactly the kind of cross-cutting concern D5 addresses. `workspace:exec` sits at the host boundary; nothing new enters the kernel or agent state machine.
- **D6 executor does environment adaptation only**: after this refactor the executor truly does *only* environment adaptation — spawn a process in the sandbox, read a file from the sandbox. Domain semantics leave the executor entirely.
