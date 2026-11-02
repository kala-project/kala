# @agent-kernel/host

The **host** for the kernel. Wraps [`@agent-kernel/kernel`](../kernel/) with everything that requires IO: LLM calls, event persistence, and the Socket.IO server that Dashboard and Executor dial into. Also serves the static dashboard bundle.

---

## Responsibilities

Host is the only process with a public IP. It owns:

1. **The host loop** (`src/loop.ts`) — consumes effects from the kernel, performs IO, feeds results back as events. Handles compaction (auto + manual), the `agent` builtin, stream cancellation, and background shell dispatch. Terminates when the kernel reaches a terminal status.
2. **LLM adapters** (`src/llm/`) — translates `Message[]` ↔ provider-specific request/response. Anthropic Messages API and OpenAI Chat Completions (also handles Codex-compatible endpoints), both streaming SSE.
3. **Session store** (`src/store/`) — in-memory session map + append-only JSONL log per session on disk. Recovers stuck sessions on load; `store/replay.ts` reconstructs state via `fold`.
4. **Connection layer** (`src/connection/`) — Socket.IO server with two namespaces (`/dashboard`, `/executor`), per-session rooms, workspace-based `tool:call` routing.
5. **Dashboard bundle server** — serves `packages/dashboard/dist/` from `/` so a single Host process is enough for a running product.
6. **Provider/model auto-import** (`src/runtime-config.ts`) — reads `~/.claude/settings.json` and `~/.codex/config.toml`, then merges manual model ids from `~/.config/kala/models.json`.
7. **Agent module assembly** (`src/agent-modules/`) — renders the default `SystemPromptPlugin` plus built-in `ToolsetPlugin[]` into the kernel config, settings metadata, and session artifacts.

## Dedicated model settings

Dedicated Runtime Units with the PostgreSQL authority and an operator provider
catalog expose dashboard-managed providers, endpoints, write-only API keys,
model IDs, and the default model. Initial loading copies the operator catalog
and resolves its keys into one tenant-bound AES-256-GCM encrypted credential
record; source files are not changed. Subsequent restarts use the saved keys.
No new schema or local configuration file is required.

Owner/admin writes are bound to the Unit organization. `POST`/`DELETE
/settings/providers`, `PATCH /settings/providers`, `POST`/`DELETE
/settings/models`, `PATCH /settings/models`, and `POST /settings/default-model` await validation and
durable commit before returning success. Omitted or blank edit keys preserve
the current credential. A provider can be created before its models.
Model metadata patches edit the label/context window without changing the model
ID or reference used by Sessions; an empty label clears the custom label.

Updates compile an immutable adapter snapshot before commit. PostgreSQL
transactional NOTIFY/LISTEN invalidates other replicas and reloads after listener
reconnection; healthy routing performs no configuration polling or per-call SQL.
Existing in-flight requests retain their adapter snapshot, and dashboard clients
receive the existing `server:agent_runtimes` event. Failed invalidations retry
only until synchronized.
Synchronization failures/recovery and post-commit observer failures are logged
without credential-bearing exception messages.

Choose another default before deleting its model/provider. Dedicated also
rejects deletion of models selected by existing Sessions: change those Session
selections explicitly first. Private Cloud operator catalogs and Portable
configuration retain their existing management behavior.

## Agent modules

The host keeps the kernel config plain, but the authored agent surface is
plugin-shaped:

```typescript
AgentModule = SystemPromptPlugin + ToolsetPlugin[] + RuntimePolicyPlugin?
```

Each `ToolsetPlugin` represents a coherent toolset, not a single tool. It owns
tool prompt text, risk metadata, and execution routing (`host` handler or
remote executor). `resolveBuiltinAgentModule()` renders those plugins into the
`systemPrompt`, `tools`, and `agentModule` metadata stored in every session
header. The same metadata drives host tool dispatch, so adding a host-side tool
does not require hard-coding the tool name in the loop.

For inspection or release checks:

```bash
kala-host --print-agent-module
kala-host --print-system-prompt
kala-host --print-tool-registry
```

## What it does NOT do

- Execute tool calls — that's the Executor's job. Host dispatches `tool:call` over the wire and awaits a result.
- Render UI — that's the Dashboard's job.
- Modify the kernel — Host imports and calls `step` / `fold`; it never patches kernel internals.

## Public entry points

```typescript
import { startHostServer } from '@agent-kernel/host'

const server = await startHostServer({
  port: 3000,
  llm: /* provider registry */,
  sessionsDir: '~/.kala/sessions',
})
```

Or run the Portable bundle directly:

```bash
node packages/host/bin/kala-host.js
# reads ANTHROPIC_API_KEY, PORT, KALA_SESSIONS_DIR from env
```

## Socket.IO Admin UI

Dedicated Runtime Units behind the authenticated Gateway expose the installed
official Admin UI at `/admin/socket.io/`. Only the deployment Owner can load its
assets or connect to its `/admin` namespace; Private Cloud organization ownership
does not grant this access. The UI uses the existing same-origin browser session
and WebSocket route, without a separate password, public port, or external
`admin.socket.io` connection. Logout/revocation closes the existing Gateway
transport.

Dedicated instrumentation stays in production mode (aggregated diagnostics,
without broad event-payload capture). Images must retain
`@socket.io/admin-ui/ui/dist` from the existing Host dependency, or provide the
embedded official assets. Missing assets leave `settings.socketAdmin.active`
false with an unavailable reason; startup never downloads them. Portable's
password-initialized Admin UI and configured instrumentation mode are unchanged.

## References

- Spec: [`docs/reference/kernel/spec.md`](../../docs/reference/kernel/spec.md) (kernel contract Host consumes)
- Wire: [`docs/protocol/wire-protocol.md`](../../docs/protocol/wire-protocol.md)
- Current log: [`docs/protocol/event-log.md`](../../docs/protocol/event-log.md)
- Target log rewrite: [`docs/architecture/host/session-log-context-persistence.md`](../../docs/architecture/host/session-log-context-persistence.md)
- Architecture: [`docs/architecture/overview.md`](../../docs/architecture/overview.md)

## Test coverage target

≥80% (per [`docs/standards/release-quality/testing.md`](../../docs/standards/release-quality/testing.md) §3). Mock the LLM at the HTTP layer, mock the Executor at the wire layer. **Do not mock the kernel** — call it directly with real state.
