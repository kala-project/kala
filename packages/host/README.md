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

## References

- Spec: [`docs/reference/kernel/spec.md`](../../docs/reference/kernel/spec.md) (kernel contract Host consumes)
- Wire: [`docs/protocol/wire-protocol.md`](../../docs/protocol/wire-protocol.md)
- Current log: [`docs/protocol/event-log.md`](../../docs/protocol/event-log.md)
- Target log rewrite: [`docs/architecture/host/session-log-context-persistence.md`](../../docs/architecture/host/session-log-context-persistence.md)
- Architecture: [`docs/architecture/overview.md`](../../docs/architecture/overview.md)

## Test coverage target

≥80% (per [`docs/standards/release-quality/testing.md`](../../docs/standards/release-quality/testing.md) §3). Mock the LLM at the HTTP layer, mock the Executor at the wire layer. **Do not mock the kernel** — call it directly with real state.
