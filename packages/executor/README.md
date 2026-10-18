# @agent-kernel/executor

The **tool runner**. A Node daemon that dials *out* to Host over Socket.IO; no inbound port required.

---

## Why "reverse-WebSocket"?

The Executor runs where the *files* live — usually behind a home router or corporate firewall — while Host lives in the cloud. So the Executor initiates the connection *outward* to Host. See [ADR 0002](../../docs/architecture/adr/0002-reverse-websocket.md).

Consequence: no port forwarding, no ngrok, no VPN. Just:

```bash
kala-executor --host=http://localhost:3000 --sandbox-root <workspace-root>
```

By default, one local executor profile maps to one workspace identity and one
single-instance lock. Use an explicit profile when a development machine must run
a test executor beside a release executor:

```bash
kala-executor --host=http://localhost:3000 --profile dev --sandbox-root <workspace-root>
```

Named profiles store their lock, `workspace-id`, and executor token under
`~/.kala/profiles/<profile>/`. The default profile continues to use the
legacy `~/.kala/` files.

## Responsibilities

1. **Tool registry** (`src/tools/`) — one file per tool from [`docs/reference/executor/tools.md`](../../docs/reference/executor/tools.md): `read_file`, `read_files`, `ls`, `glob`, `grep`, `write_file`, `replace_in_file`, `replace_many_in_file`, `apply_file_patch`, `bash`, `memory`, `websearch`, `webfetch`, `bash_output`, `kill_shell`.
2. **Sandbox** (`src/sandbox.ts`) — workspace whitelist. Every path is resolved and rechecked to prevent escape via `..`, absolute paths, or symlinks.
3. **Background shell registry** (`src/background.ts`) — `bash --run-in-background` → `taskId`; `bash_output`; `kill_shell`.
4. **Socket.IO client** (`src/client.ts`) — dials Host's `/executor` namespace; announces `workspaceId` / `workspaceName` / `os` / `runtime` / `sandboxRoots` / tool names; handles `tool:call` / `fs:list_dirs` / cancel; auto-reconnects and re-announces.

## What it does NOT do

- Contact any LLM.
- Persist session state — Host owns the JSONL log.
- Decide whether a tool call needs user approval — that's Host + Dashboard's decision; Executor just runs what Host dispatches.
- Host the `agent` builtin — that's host-side (see [ARCHITECTURE.md](../../docs/architecture/overview.md)); it does not appear in the executor tool registry.

## Public entry points

```typescript
import { startExecutor } from '@agent-kernel/executor'

await startExecutor({
  host: 'http://localhost:3000',
  sandboxRoots: ['<workspace-root>'],
  token: process.env.EXECUTOR_TOKEN,
})
```

## References

- Tool contracts: [`docs/reference/executor/tools.md`](../../docs/reference/executor/tools.md)
- Wire protocol: [`docs/protocol/wire-protocol.md`](../../docs/protocol/wire-protocol.md)
- Architecture: [`docs/architecture/overview.md`](../../docs/architecture/overview.md)
- Spec: [`docs/reference/kernel/spec.md`](../../docs/reference/kernel/spec.md)

## Test coverage target

≥90% (per [`docs/standards/release-quality/testing.md`](../../docs/standards/release-quality/testing.md) §4). Each tool has a test file covering happy path, missing file, permission denied, invalid schema, idempotency where relevant, and tool-specific edge cases. Sandbox has its own dedicated test suite for path-escape attempts.
