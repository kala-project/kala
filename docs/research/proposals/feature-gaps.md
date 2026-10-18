# Feature Gap Analysis: agent-kernel vs Reference Coding Agents

This document compares `agent-kernel` with reference coding-agent implementations that were reviewed locally: pi, opencode, codex, claude-code-collection, azure-code-agent-hub-pr879, hermes-agent, and openclaw. It records what already exists, what is intentionally out of scope, and which ideas are worth revisiting later.

---

## 1. Implemented Capabilities

### 1.1 Context compaction and summaries

Host tracks token usage, derives context pressure, calls an LLM summarizer, and writes deterministic `messages_replaced` events. Full compaction request, response, and report data are stored as artifacts and runtime metadata. Replay restores the same model-visible context without re-calling a summarizer. Manual `/compact`, the composer pressure banner, hard-pressure compaction, and preflight compaction are implemented.

### 1.2 Sub-agent dispatch

`agent` is a host-side built-in tool, not an executor tool. It opens a child JSONL session in the same workspace, inherits the parent `approvalMode`, respects `maxAgentDepth`, and returns the child assistant result as the parent `tool_result`.

### 1.3 Session resume and fork

Fork emits `session:forked` and creates an independent JSONL log without modifying the parent. Resume uses `server:history` replay. Sessions stuck in approval or tool execution are repaired during store load by synthesizing approval/tool-result completion events. Sessions stuck in `thinking` are recovered with an interrupted LLM response.

### 1.4 Approval and permission modes

The kernel owns `approvalMode`: `auto`, `ask`, `deny`, and `allow_all`. `client:set_approval_mode` switches modes. `allow_all` requires the host environment guard `KALA_ALLOW_ALL_OK=1`, and the dashboard confirms the switch.

### 1.5 Precise editing

The `edit` tool performs exact string replacement with an optional `replace_all` flag. Approval cards render unified diffs for `edit` and `write`; old file content is fetched through the executor `read` path.

### 1.6 Task planning

Host `todo_graph` is the only default planning tool. Its durable results drive the current Task Graph UI and autonomous-work recovery. The dashboard still parses historical `todowrite` calls and renders the legacy Task List UI so existing sessions remain replayable; that compatibility path is not a catalog registration or executable handler.

### 1.7 Token and context accounting

`state.usage` tracks input, output, cache-creation, and cache-read tokens. The composer displays current turn token counts and context pressure. The product UI deliberately does not show monetary cost.

### 1.8 Multi-model support

Anthropic Messages API and OpenAI-compatible adapters are implemented, including Codex-style endpoints. Provider and model lists can be imported from Claude and Codex config files, then merged with manually configured model IDs. Dashboard reads settings through HTTP and supports manual model management.

### 1.9 Streaming UX

Anthropic and OpenAI-compatible adapters stream SSE deltas. `session:token_delta` drives incremental dashboard rendering. `client:cancel_stream` and Escape cancel the active stream. JSONL stores only the final `llm_response`, not every delta.

### 1.10 Built-in web search

`web_search` is an executor built-in and does not require approval. It queries DuckDuckGo HTML results, parses title, URL, and snippet, bounds snippets to 500 characters, and times out after 15 seconds.

### 1.11 Image input

Kernel message content supports image blocks. Anthropic and OpenAI-compatible adapters pass image content through. The dashboard renders thumbnails and supports pasted clipboard images with removable previews before submit.

### 1.12 User-message edit and rerun

User messages expose an edit affordance. Submitting an edit forks from that cursor and uses the edited text as the child session seed message.

### 1.13 Session rename

Explorer rows support inline session rename. `client:rename_session` appends metadata to JSONL. Empty labels clear the custom label and fall back to `firstUserMessage`.

### 1.14 Workspace and session metadata dialogs

Workspace and session rows expose metadata dialogs. Workspace metadata reads executor announce data; session metadata reads the JSONL header and folded state. Both are read-only.

### 1.15 Session creation UI

The dashboard New button opens a creation flow: choose workspace, pick cwd through a Finder-style directory picker, and select provider/model. Host validates cwd against executor sandbox roots and persists `initialCwd` in the JSONL header.

### 1.16 Session cwd editing

The toolbar displays and can change the current cwd. `client:set_cwd` only applies to sessions in idle/done/error states. If a session is workspace-bound, the corresponding executor must be online so host can validate the path against sandbox roots. Success writes a `cwd_changed` event and future `call_tool` effects carry the new cwd.

### 1.17 Background shell

`bash { run_in_background: true }` starts an executor-side background task and returns a task id. `bash_output` polls logs and `kill_shell` terminates. The dashboard derives a background terminal panel from normal tool results; no extra wire event is introduced.

### 1.18 Theme

Light and dark themes use Tailwind plus shadcn semantic HSL tokens. Settings controls theme selection.

### 1.19 Hooks system

`pre_tool_use`, `post_tool_use`, `session_start`, and `session_end` hooks run external commands configured in `~/.config/kala/config.toml`. Host loop triggers hooks around tool dispatch and session lifecycle. Hook payloads are JSON over stdin. `pre_tool_use` non-zero exit blocks the tool and produces a failed `tool_result`.

### 1.20 Extended thinking

Anthropic thinking mode is supported by adding `thinking: { type: 'enabled', budget_tokens: N }`. SSE parsing recognizes thinking blocks and signatures, stores them as opaque `ThinkingContent`, and renders them in collapsible dashboard UI.

### 1.21 Prompt caching

Anthropic adapter can apply ephemeral cache-control breakpoints to system prompt, tool definitions, and the final non-assistant message. Usage accounting records cache creation/read tokens. OpenAI-compatible responses read cached token counts from `prompt_tokens_details.cached_tokens` where available.

### 1.22 Three-layer memory

`memory` is one executor tool with `operation: list | read | write | delete` and `scope: session | workspace | global`. It should not be split into separate `memory_read`, `memory_write`, and `memory_delete` tools. Session scope is the only reducer-lift exception: successful session memory writes/deletes update `state.memory[]`. Workspace memory persists under the workspace `.kala/memory/`; global memory persists under the user `.kala/memory/`. Keys are constrained to avoid path traversal and content is size-bounded.

---

## 2. Explicit Non-Goals

- Command-history navigation with the Up key.
- Fuzzy `@file` selection.
- Monetary-cost footer display.
- Extra slash commands such as `/model`, `/help`, or `/clear` beyond the currently supported set.
- Multi-provider fallback.
- TUI, IDE integration, or plugin APIs.
- Implicit CLAUDE.md auto-loading. Users can synchronize equivalent material through memory tools, but prompt-time injection must remain explicit.
- A separate `web_fetch` tool. It overlaps with `web_search`, creates SSRF and authentication policy cost, and is not central to the coding-agent path.
- SaaS multi-user platformization. The project targets a self-hosted single-user kernel/host/executor architecture.
- End-to-end encryption of live kernel state. Replay and fork require plaintext state at runtime; at-rest JSONL encryption would be the lower-cost path if needed.

---

## 3. Planned Work

### 3.1 MCP runtime

The design is settled but implementation is deferred. MCP configuration belongs to executor CLI/environment configuration, not kernel or wire protocol. Tool names are prefixed as `<server_name>__<tool_name>`. MCP tools use the same approval mode as built-ins. The official `@modelcontextprotocol/sdk` client should be introduced only in the executor package.

The reason to defer is practical: current built-ins cover the main coding-agent workflows. MCP's marginal value is strongest for non-local integrations such as Slack, Notion, and Jira.

### 3.2 Core boundary cleanup

The high-level layering is healthy: kernel remains a pure reducer, host executes effects and policy, executor runs tools, and dashboard observes events/state. The next cleanup targets are large dashboard composition files and inspector internals.

`packages/dashboard/src/app.tsx` should continue splitting responsibilities into boundary hooks such as URL state, theme preference, global shortcuts, session control actions, and intervention effects.

`packages/dashboard/src/features/inspector/InspectorPanel.tsx` should continue moving pure trace derivation into `debugger-model.ts`, and visual sections into smaller Reducer Trace, LLM Calls, Tool Calls, and Runtime Objects components.

Provider HTTP trace data must stay event-log metadata/debug data. It should not become a reducer event or `AgentState` field.

Review rule: classify each new feature as core protocol, host orchestration, executor capability, dashboard observer, or UI presentation. Only core protocol changes may extend kernel event/effect/state.

---

## 4. Reference Comparison

| Capability | agent-kernel | pi | opencode | codex | claude-code | hermes | openclaw |
|---|---|---|---|---|---|---|---|
| Pure reducer kernel | yes | yes | no | yes | no | no | no |
| Reverse executor connection | yes | no | yes | no | no | no | no |
| JSONL event log | yes | yes | yes | yes | partial | partial | partial |
| Fork / replay | yes | yes | no | no | no | no | no |
| Approval mode | four modes | three | three | two | three | two | many |
| Sub-agent | host built-in | yes | no | no | yes | yes | registry |
| Automatic compaction | reactive | yes | yes | no | yes | yes | preemptive |
| Image input | yes | yes | yes | yes | yes | yes | yes |
| Theme switching | yes | no | yes | no | n/a | n/a | n/a |
| Hooks | yes | no | yes | no | yes | no | no |
| Extended thinking | yes | no | no | no | yes | no | no |
| Prompt caching | yes | no | no | no | yes | no | no |
| Three-layer memory | yes | partial | yes | no | CLAUDE.md-style | yes | partial |
| MCP runtime | deferred | yes | yes | no | yes | no | yes |

---

## 5. Reference Audit Notes

### 5.1 Structured failover errors

openclaw carries provider fallback failures as structured reasons such as billing, rate limit, auth, context overflow, and timeout. This would be useful once real multi-provider fallback exists. Today single-provider usage does not justify the extra structure.

### 5.2 Head-and-tail tool-result truncation

openclaw preserves both head and tail of large tool results. The current project uses a simpler threshold and preview strategy. Tail preservation is worth adding if agents repeatedly miss error summaries near the end of output.

### 5.3 Preemptive compaction routing

openclaw can trim tool results before the next model request rather than immediately running a full summarizer. This is worth revisiting after overflow handling is stable.

### 5.4 Loop detection and circuit breaker

openclaw detects repeated tools, ping-pong patterns, unknown tools, and no-progress polling. This belongs in host policy or hooks, not kernel.

### 5.5 Persistent sub-agent registry

openclaw has a durable sub-agent registry with delivery retries and orphan detection. This project should not copy that design now because replay-based JSONL sessions already provide the core persistence model.

### 5.6 Multi-provider advisor calls

hermes-agent runs multiple provider advisors and aggregates their suggestions. This is intentionally out of scope: it multiplies per-turn cost and is a feature choice, not a core architecture need.

### 5.7 Turn retry state object

hermes-agent centralizes retry guards in a Python dataclass. The current event-log and reducer model can reconstruct turn state without adding an equivalent intermediate object.
