# Roadmap

Feature ledger for `agent-kernel`: what ships today, what's deferred, and what's out of scope.

For the current comparison against reference agents (pi / opencode / codex / Claude Code), see [FEATURE-GAPS.md](research/proposals/feature-gaps.md).

---

## Shipped

### Kernel — `packages/kernel/`

Pure-function FSM. Zero runtime dependencies. Production code ~350 LOC.

- Types: `types.ts` — `Message` / `Event` / `State` / `Effect` / `Config`
- FSM step: `core.ts` — `step(state, event, config)` via a dispatch table (see [ADR 0010](architecture/adr/0010-fsm-dispatch-table.md))
- State factory: `state.ts` — `createInitialState()`, `createConfig()`
- Fold / fork: `fold.ts` — `fold`, `foldWithTrace`, `fork`

Every invariant in [SPEC.md](reference/kernel/spec.md) §5 is tested.

### Host — `packages/host/`

The single process with a public IP. LLM calls, event persistence, Socket.IO server, dashboard bundle server.

- `src/loop.ts` — consumes effects from the kernel, performs IO, feeds results back as events. Handles compaction (auto + manual), the `agent` builtin, stream cancellation, background shell dispatch.
- `src/llm/anthropic.ts` — Anthropic Messages API (streaming SSE).
- `src/llm/openai.ts` — OpenAI Chat Completions (also handles Codex-compatible endpoints), streaming SSE.
- `src/llm/index.ts` — provider registry, model → adapter mapping.
- `src/store/session.ts` — in-memory session map + append-only JSONL log per session on disk. Recovers stuck sessions on load.
- `src/store/replay.ts` — load from JSONL, produce state via `fold`.
- `src/connection/server.ts` — Socket.IO server with two namespaces (`/dashboard`, `/executor`), per-session rooms, workspace-based `tool:call` routing.
- `src/connection/dashboard.ts` — dashboard event handlers.
- `src/connection/executor.ts` — executor event handlers.
- `src/runtime-config.ts` — auto-imports providers/models from `~/.claude/settings.json` and `~/.codex/config.toml`, merged with manual model ids in `~/.config/kala/models.json`.
- `bin/kala-host.ts` — CLI. Also serves `packages/dashboard/dist/`.

Plus `packages/shared/src/protocol.ts` — wire protocol types shared across host / executor / dashboard.

### Executor — `packages/executor/`

Node daemon that dials out to Host. No inbound port required (see [ADR 0002](architecture/adr/0002-reverse-websocket.md)).

- `src/tools/` — one file per tool from [tools.md](reference/executor/tools.md): `read`, `ls`, `glob`, `grep`, `write`, `edit`, `bash`, `memory`, `web_search`, `bash_output`, `kill_shell`.
- `src/tools/index.ts` — tool registry + input-schema validation (ajv).
- `src/sandbox.ts` — workspace whitelist enforcement (symlink-aware).
- `src/client.ts` — Socket.IO client to Host; announces `workspaceId` / `workspaceName` / `os` / `runtime` / `sandboxRoots` / tool names; handles `tool:call` / `fs:list_dirs` / cancel.
- `src/background.ts` — per-executor background shell registry (`bash --run-in-background` → `taskId`; `bash_output`; `kill_shell`).
- `bin/kala-executor.ts` — CLI.

The `agent` builtin is host-side, not executor-side; it does not appear in the executor tool registry.

### Dashboard — `packages/dashboard/`

React SPA served by Host from `packages/dashboard/dist/`. Vite + React + Tailwind + shadcn semantic tokens. Light / dark themes.

Five-column Finder-style layout (see [ADR 0013](architecture/adr/0013-dashboard-finder-layout.md)):

- `src/features/explorer/` — two-level tree of workspaces + sessions with time-bucket grouping, cwd surfacing, rename-in-place, Info dialogs for workspace and session metadata.
- `src/features/chat/` — chat panel (text + image blocks, streaming render, compact boundary marker, user message edit + fork, image paste), Composer (model picker, context pressure ring, approval mode picker, `/compact` slash command, context pressure banner).
- `src/features/inspector/` — state tree viewer, event timeline (with compaction request details), effects panel, usage panel, approval cards with unified diff for `edit` / `write`.
- `src/features/history/` — replay scrubber, fork button on any event.
- `src/features/settings/` — provider list (auto-imported + user-added), model picker per provider, approval mode default, host / port config.
- `src/features/create-session/` — workspace picker + Finder-style cwd picker + provider/model picker.
- `src/features/background/` — background terminal panel derived from `bash` / `bash_output` / `kill_shell` events.
- `src/features/activity/` — bottom activity bar (runtime status, permission banners).

### Replay & Fork

The differentiating capability.

- Host: `client:fork` handler creates a new JSONL with a fork header (see [event-log.md](protocol/event-log.md) §5). Fork header inlines the folded state so parent logs can be archived without breaking the child.
- Dashboard: session list from the JSONL directory (`server:sessions`), timeline scrubber, Fork button on any event.
- Snapshot writing (optional performance hack): every N events or on turn-end, write a `snapshot` entry. Deleting snapshots is always safe.

---

## Deferred

### Browser Executor (WebContainer)

Intentionally out of v1 scope. The extension point is designed but the WebContainer adapter is not shipped.

The wire protocol and Socket.IO client contract already permit a browser-side executor (the executor doesn't own kernel state, only tool execution). Shipping a WebContainer adapter would require an FS + spawn interface refactor across the tools (WebContainer's API is `fs.promises`-style but posix-only, no sync variants, no realpath), COOP/COEP cross-origin isolation headers in the dashboard Vite config, StackBlitz auth token handling, and browser-side manual QA. v1's contribution stops at "the kernel, host, and dashboard are agnostic to how tools run" — the Node executor is proof enough of that decoupling.

### Larger deferred items

See [FEATURE-GAPS.md](research/proposals/feature-gaps.md) §3 for the concrete short list and §2 for the "never" list. The larger-scope items that are not simple to slot in:

- **Additional LLM adapters**: local llama.cpp / ollama; anything with a non-OpenAI-compat wire format.
- **MCP runtime**: expose the executor as an MCP server; consume third-party MCP tools at runtime. Currently a config-only stub.
- **Multi-executor per session**: routing different tool names to different workspaces within one turn. Intentionally not designed for (see [ARCHITECTURE.md](architecture/overview.md) §4.3).
- **Kernel port to Rust**: same spec, different impl language, for embedding in non-JS environments.
- **Extension API**: a documented way to add planning / memory / subagent orchestration around the kernel, without patching it.
- **Session sharing**: publish a session (JSONL) as a public URL, viewable but not forkable. Doubles as a bug-repro tool.

---

## Cross-cutting

- **Test coverage**: kernel 100%, host ≥80%, executor tools ≥90%, dashboard component + puppeteer computedStyle cross-check for theme / layout changes (see [testing.md](standards/release-quality/testing.md) §5.3).
- **Docs currency**: any protocol / spec change requires the corresponding doc PR in the same commit.
- **CI**: GitHub Actions running `pnpm typecheck && pnpm test && pnpm build` on PRs.
- **Examples**: `examples/` walkthroughs double as regression checks.

---

## Non-goals

- **Not a Claude Code / Codex competitor.** Reference implementation and teaching artifact, not a product with a paid tier.
- **Not an orchestration framework.** Kernel doesn't do orchestration (see [ADR 0005](architecture/adr/0005-kernel-boundary.md)). We don't chase LangGraph / crewai's feature set.
- **Not a UI framework.** Dashboard is one artifact of one deployment. If someone wants a TUI, VS Code extension, or CLI-only front-end, they can build on top of the kernel and protocol.
