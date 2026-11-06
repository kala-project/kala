# Git Context & Commit Pre-flight Aggregator (`git_context`) — Source-of-Truth Design

**Status:** Source of Truth (SoT)
**Scope:** `packages/executor` (`src/tools/git-context.ts`, `src/tools/index.ts`), `packages/host` (`src/builtin-tools.ts`)
**Deployment Coverage:** Portable (local Executor), Dedicated (remote WebSocket Executor), Private Cloud (multi-replica Host + remote Executor with owner lease fencing)

---

## 1. Problem Statement & Motivation

Before inspecting changes, reviewing code, or creating a Git commit, an Agent typically needs to know:
- What branch is checked out, its HEAD commit SHA, and whether it is ahead/behind its upstream tracking branch.
- Which files are staged, unstaged, untracked, or in merge conflict.
- Diff statistics and unified diff patches for staged and/or unstaged changes (or relative to a `base_ref`).
- Recent commit history to follow the repository's commit message style (e.g., Conventional Commits).
- Whether any staged/modified files accidentally include `.env` files, private keys, API tokens, or unresolved `<<<<<<<` conflict markers.

Previously, gathering this required 4–5 sequential `shell` tool calls (`git status`, `git branch -vv`, `git diff`, `git diff --cached`, `git log -n 5`), consuming multiple LLM turns and triggering approval prompts when `shell` requires approval.

The **`git_context`** tool aggregates this in one read-only (`requiresApproval: false`) Executor tool call. All Git invocations use `--no-optional-locks`; this is not a substitute for reviewing the complete changes before committing.

---

## 2. Architecture & Multi-Deployment Design

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Host (`packages/host/src/builtin-tools.ts`)                             │
│  - Registers `git_context` in `filesystemToolset` (`execution: 'executor'`,│
│    `risk: 'read'`, `requiresApproval: false`)                           │
│  - `ExecutorRegistry.callTool` enforces `assertSessionEffectOwner`      │
│    before dispatching to remote Executors in Dedicated / Private Cloud  │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │ Socket.IO / Local ToolRunner
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Executor (`packages/executor/src/tools/git-context.ts`)                 │
│  1. Sandbox Check: resolve cwd, repository root, and Git metadata paths │
│  2. Lock-Free Git Queries (`execFile('git', ['--no-optional-locks',..])`)│
│     - `rev-parse --show-toplevel`                                       │
│     - `status --porcelain=v2 --branch -z`                                 │
│     - `diff --cached --stat` & `diff --stat`                            │
│     - Scoped unified diff (`all` | `staged` | `unstaged` | `base`)      │
│       bounded by `max_diff_chars` and a UTF-8 byte limit                 │
│     - `log -n <log_limit>` (structured commits)                         │
│  3. Commit Pre-flight Scanner:                                          │
│     - Sensitive filenames (`.env`, `*.pem`, `*.key`, `id_rsa`, etc.)    │
│     - Secret token patterns in added diff lines (`PRIVATE KEY`,         │
│       `AKIA...`, `ghp_...`, `sk-...`)                                   │
│     - Leftover merge conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Deployment Mode Guarantees

| Deployment Mode | How `git_context` Operates |
|---|---|
| **Portable Mode** | Runs directly in the local Executor process against the workspace sandbox. |
| **Dedicated Mode** | Host dispatches `git_context` over Socket.IO to the remote Executor container/machine where the Git repository lives. No shared filesystem between Host and Executor is needed. |
| **Private Cloud Mode** | The Host dispatch path checks session ownership before the remote Executor call. The Executor additionally enforces its configured sandbox roots; a sandbox with no roots is intentionally unrestricted (operator policy). Linked worktrees are rejected when their `.git` metadata or common Git directory falls outside those roots; operators must explicitly authorize both paths. |

---

## 3. Tool Contract & Parameters

Tool name: `git_context` (execution kind: `executor`, risk: `read`, `requiresApproval: false`)

| Parameter | Type | Default | Description |
|---|---|---|---|
| `cwd` | `string` | Session/workspace `cwd` | Optional directory inside the workspace sandbox to inspect. |
| `scope` | `'all' \| 'staged' \| 'unstaged' \| 'base'` | `'all'` | Which unified diff to include in `diff.patch`. |
| `base_ref` | `string` | `undefined` | Optional Git ref (e.g. `'HEAD~1'`, `'main'`) when `scope='base'` or comparing against a base branch. |
| `include_diff` | `boolean` | `true` | Whether to include unified diff hunks in `diff.patch` (`false` returns only stats and status). |
| `max_diff_chars` | `integer (500..64000)` | `12000` | Maximum characters of unified diff returned before truncation; also capped to the same number of UTF-8 bytes. |
| `log_limit` | `integer (0..25)` | `5` | Number of recent commits to return in `recentCommits`. |

---

## 4. Verification & Acceptance Criteria

1. Returns accurate branch metadata (`head`, `oid`, `detached`, `upstream`, `ahead`, `behind`), file status (`staged`, `unstaged`, `untracked`, `conflicted`), diff stats, budget-capped unified diff, and recent commit log.
2. Uses `--no-optional-locks` on every Git process, disables the fsmonitor/untracked cache and external diff/textconv helpers, and strips inherited `GIT_*` process variables. Git is never invoked through a shell; `base_ref` is an argument, rejects option-like refs, and precedes `--`.
3. Emits `preflightWarnings` when sensitive files (`.env`, `*.pem`, `id_rsa`), added secret tokens (`PRIVATE KEY`, `ghp_...`), or leftover conflict markers (`<<<<<<<`) are present, while allowing safe template files (`.env.example`).
4. Enforces Executor workspace sandbox boundaries (`EACCES` for `cwd`, discovered repository root, or Git metadata outside the configured roots). This is a path policy, not a hermetic Git sandbox: Git still reads local repository/configuration data as the Executor user. Provision roots and repositories per tenant.
5. Fails closed if any Git command fails, times out (15 seconds per process), is canceled, or exceeds its 1 MiB process output cap; returned JSON is capped at 128 KiB. Large diffs are **not** silently scanned in part.
6. Preflight scans added lines in tracked staged and unstaged diffs regardless of requested display scope and redacts common token formats, credential assignments, URLs with passwords, and complete PEM private keys from returned strings. When a sensitive filename or detectable credential appears, the displayed patch is suppressed (`diff.truncated: true`) rather than exposing unknown credential contents. It does **not** inspect untracked file contents, binary diff contents, omitted Git objects, arbitrary credential formats, or the full value of an incomplete PEM key. Filenames are checked even when contents are not. Warnings are heuristic and never certify that a commit is secret-free; do not paste unreviewed output into third-party systems.
