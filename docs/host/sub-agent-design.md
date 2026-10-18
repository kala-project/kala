# Sub-agents — Design v2

Status: live inline observability implemented; interruption implemented; agent-type registry still planned
Owner: host + dashboard
Related: [tools.md](../reference/executor/tools.md), [protocol/wire-protocol.md](../protocol/wire-protocol.md), [ARCHITECTURE.md](../architecture/overview.md), [adr/0014-subagent-approval-mode.md](../meta/adr/0014-subagent-approval-mode.md)

## 1. What we already have

A minimum-viable sub-agent stack has been in-tree for a while:

- **Tool schema** — `agent` tool in `packages/executor/src/tools/agent.ts`. Fields: `prompt` (required), `model`, `tools` (allowlist).
- **Host-side handler** — `packages/host/src/extensions/agent-tool.ts`. Creates a *child JSONL session* via `SessionStore.create()` with `parentSessionId` + `parentCursor` set, inherits `workspaceId`/`workspaceName`/`cwd`, forces `initialApprovalMode: 'allow_all'` (see [ADR 0014](../meta/adr/0014-subagent-approval-mode.md)), then drives the child through the host loop and returns an enveloped result.
- **Depth limit** — `AgentConfig.maxAgentDepth` is hard-capped to 1 by default: root sessions may spawn a child, but sub-agents do not receive the `agent` tool and cannot recursively spawn another sub-agent.
- **Loop dispatch** — `packages/host/src/loop.ts:317` special-cases `AGENT_TOOL_NAME`, so a `call_tool` effect for `agent` invokes `runAgentTool()` instead of the executor bridge.
- **Store parent-child links** — `SessionRecord` carries `parentSessionId` + `parentCursor` (`packages/host/src/store/session.ts`). `SessionReadyEvent` in `packages/shared/src/protocol.ts` propagates them to clients.
- **Explorer + metadata dialog** — the dashboard shows "fork of `<sha>…`" in the session list and a "Parent" jump in `SessionMetadataDialog`.

This works: the sub-agent runs, the parent gets its final text back as a `tool_result`, the operator can watch the child inline, and an active child can be interrupted from the parent card. The remaining product gaps are:

1. **The tool is still under-discoverable.** The `agent` tool is in the schema, but no built-in agent "types" ship yet in the Codex/Claude Code sense, and there is no authoring UI for custom types.
2. **The registry is still a planned config layer.** The runtime path is intentionally isolated child sessions today; named agent types are the next ergonomic layer, not a different execution model.
3. **Background sub-agents remain out of scope.** Children still block the parent tool call until they complete, fail, or are interrupted.

We are keeping the backend architecture — it is quietly solid. This document specifies (a) the wire events + dashboard rendering to make sub-agent runs observable inline, and (b) a minimal "agent types" facility so users can define reusable prompts + tool policies.

## 2. Reference designs

### Claude Code — `Agent`/`Task` tool

- Tool input: `{ subagent_type, description, prompt, model?, run_in_background?, isolation? }`. `subagent_type` names one of a registered set (`general-purpose`, `Explore`, `Plan`, custom user-defined types).
- **Isolated inner loop.** Fresh context, own tool loop, own transcript file at `<agent-log-root>/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`.
- Foreground blocks the parent turn; background (default since v2.1.198) runs concurrently, permission prompts surface in the parent naming the sub-agent.
- Parent can emit **multiple `Agent` tool_use blocks in one message** to run children in parallel.
- Tool return: single text string. Trailer `agentId: <id>` appended so parent can `SendMessage` to resume it.
- Custom types = markdown-with-frontmatter files under `.claude/agents/` or `~/.claude/agents/`. Frontmatter fields: `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`. Body = system prompt. Hot-reloaded.
- Recursion allowed up to depth 5.
- Model resolution: `CLAUDE_CODE_SUBAGENT_MODEL` env → per-invocation `model` → definition frontmatter → parent's model.

### Codex CLI — `multi_agents_v2`

- **Non-blocking spawn.** `spawn_agent` returns immediately with `{ task_name, nickname }`. Parent uses separate `send_message`, `followup_task`, `wait_agent`, `list_agents`, `interrupt_agent` tools. Content flows through a side-channel of `SubAgentActivityEvent`s rendered in a distinct TUI pane, **not** through the `tool_result` of the spawn call.
- **Fork axis.** `fork_turns: "none" | "all" | <int>` decides how much parent history the child sees. `all` = full parent transcript forked in (model/reasoning/role overrides rejected in that mode).
- Roles: TOML files under `<codex_home>/agents/*.toml` or inline in `config.toml`, each providing a `ConfigToml` layer (tool policy, model, reasoning effort).
- Per-spawn overrides: `model`, `reasoning_effort`, `service_tier`.

### opencode — `task` tool

- Simpler synchronous default. `task` tool input: `{ description, prompt, subagent_type, task_id?, background? }`. Child = new `Session` with `parentID = ctx.sessionID`, own inner loop.
- Returns a wrapped envelope: `<task id="…" state="completed"><task_result>…final text…</task_result></task>` — only the child's last text part; the tool description explicitly says "The result returned by the agent is not visible to the user."
- Child sessions ARE navigable in the TUI as sibling sessions.
- Two ways to define agents: JSON under `agent.<name>` in `opencode.json`, or markdown with YAML frontmatter under `.opencode/agent/` (project) or `~/.config/opencode/agents/` (global). Filename = agent name.
- Per-agent tool policy: `permission.{edit,bash,webfetch,task}` and per-tool + bash-glob rules, `allow | ask | deny`, last-match-wins. Auto-denies recursive `task` and `todowrite` unless re-enabled.

### What we're taking and skipping

- **Take from Claude Code:** the *concept* of named agent types (markdown + frontmatter), the depth cap on recursion, model-inheritance chain, and multiple parallel `agent` tool_use blocks in one assistant message (already free — the loop already dispatches parallel tool calls).
- **Take from opencode:** the wrapped envelope result (`<task id="..." state="...">…</task>`) so the parent's transcript is self-describing without needing the dashboard to hide raw output. Also the "child session navigable as sibling" affordance — we half-have this via Explorer.
- **Skip Codex's non-blocking spawn model.** Our synchronous flow is simpler and matches how the LLM already thinks. We can revisit if/when we want long-lived background research agents.
- **Skip Codex's `fork_turns: "all"`.** Sharing parent history is a footgun — the child bloats context immediately, and if the parent later compacts, the child's transcript becomes hard to reason about. Fresh context per sub-agent is a real feature.

## 3. Design principles

1. **Backend is already right — do not re-plumb.** The sub-agent runs as an isolated child session in `SessionStore` with its own JSONL log; the parent sees a synchronous `tool_result`. Don't change that.
2. **Inline observability is the missing feature.** The dashboard should render a sub-agent's transcript *inside the parent's transcript* as a live, collapsible card — not as a separate tab you have to hunt for.
3. **The child's dashboard socket state stays independent.** Users can still open the child in its own tab if they want the full-screen experience. The parent-inline view is a *summary/preview* that reuses the same transcript data.
4. **One event stream is authoritative.** The child session already emits `event:appended`/`state:changed` through the loop's broadcast; the dashboard just needs to subscribe to the child room while it's viewing the parent, and know which `tool_call` on the parent maps to which child session.
5. **Agent types are a config layer, not a fork of the loop.** They resolve into a `{ systemPrompt, allowedTools, model }` triple that gets merged into the child's `AgentConfig` at spawn time. No new code paths, just a lookup + merge.

## 4. Where things live

```
packages/executor/src/tools/agent.ts              schema — extend with agent_type, description
packages/host/src/extensions/agent-tool.ts        spawn handler — active registry, interruption, envelope, future agent-type resolution
packages/host/src/agent-registry.ts               NEW — load + hot-reload agent type definitions
packages/host/src/loop.ts                         no change to dispatch, add child-session subscription hint
packages/shared/src/protocol.ts                   NEW event types: server:sub_agent_started, server:sub_agent_finished
packages/dashboard/src/features/chat/SubAgentCard.tsx  NEW — inline collapsible sub-agent renderer
packages/dashboard/src/features/chat/useSubAgentSession.ts NEW — hook that subscribes to a child session by id
packages/dashboard/src/features/chat/ChatPanel.tsx map agent tool_call → SubAgentCard instead of generic ToolCallGroupBlock
docs/host/sub-agent-design.md                          this doc
```

## 5. Protocol

### Envelope in `tool_result.content`

The parent's `tool_result` today is the child's last-assistant text. We wrap it in a small envelope to make it self-describing and to give the dashboard a stable place to hang the "expand the child transcript" affordance without heuristics:

```
<sub_agent
  session_id="<child sessionId>"
  agent_type="<name>"
  status="completed"
  turns="7"
  duration_ms="42137"
>
<result>
…final assistant text…
</result>
</sub_agent>
```

The wrapper is text (not JSON) so it renders acceptably even without special-case UI, and so it survives log compaction. The dashboard parses the opening tag with a permissive regex and, on match, renders `<SubAgentCard>` instead of the raw text. If the tag is malformed or missing, we fall back to the plain grouped-tool-call renderer — so the feature degrades to "just text" cleanly.

For failures (`{ ok: false }`), the envelope is `status="failed"` with a `<error>…</error>` block instead of `<result>`. User interruption and parent-cancel cascade use `status="cancelled"` with the cancellation reason in `<error>`.

### New push events

Two events, on the `/dashboard` namespace only:

- `server:sub_agent_started` — emitted by the host at the moment `runAgentTool()` calls `SessionStore.create()` for the child. Fields:
  ```ts
  {
    parentSessionId: string
    parentCallId: string           // the agent tool's callId
    childSessionId: string
    agentType?: string
    prompt: string
    model?: string
    startedAt: string              // ISO 8601
  }
  ```
- `server:sub_agent_finished` — emitted just before `runAgentTool()` returns. Fields:
  ```ts
  {
    parentSessionId: string
    parentCallId: string
    childSessionId: string
    status: 'completed' | 'failed' | 'cancelled'
    turns: number                  // child.state.cursor (approximate)
    durationMs: number
    finishedAt: string
    error?: string                 // present when status !== 'completed'
  }
  ```

Both events are fanned into the parent's `session:<parentSessionId>` room. The dashboard uses them to (a) show a live "N sub-agents running" indicator, (b) transition the SubAgentCard from "in progress" to "completed", and (c) know the `childSessionId` before the tool_result envelope arrives — so it can start streaming the child transcript inline while the child is still running.

### Child transcript subscription

The dashboard, upon receiving `server:sub_agent_started`, calls the existing `session:subscribe` (or equivalent — the room-join pattern used for regular sessions) with `childSessionId`. From that point it receives all `event:appended` / `state:changed` events for the child, exactly the same as if the child were the active session. The parent view multiplexes them by session id.

We do NOT add a new "subscribe to child from within parent" RPC — the existing per-session room infrastructure is sufficient.

### Client interruption

The dashboard can interrupt a live child from the inline `SubAgentCard` without opening the child session:

```ts
socket.emit('client:interrupt_sub_agent', {
  parentSessionId,
  parentCallId,
  childSessionId, // optional guard against stale UI rows
})
```

The host marks the active sub-agent entry as cancelled, then dispatches `cancel` to the child session through the same loop path used by normal session cancellation. That keeps LLM stream aborts and executor tool cancellation in the loop-owned abort registry instead of creating a second cancellation channel.

If the child already finished, the host broadcasts a `session:error` to the parent session with `scope: 'host'` and leaves the finished envelope unchanged.

### RPC additions

Two dashboard RPCs to make the feature complete:

- `agent_types:list` — returns the built-in role templates (`research`, `implementation`, `test`, and `review`) as `{ types: Array<{ name, description, model?, tools?, systemPromptPreview? }> }`. A future registry loader may add workspace and user-defined types. Used by the Composer / future "@agent-name" affordance.
- `sub_agent:list` — returns children of a given parent: `{ parentSessionId, children: Array<{ childSessionId, agentType?, status, startedAt, finishedAt?, turns?, durationMs?, error? }> }`. It combines child records with the durable parent `<sub_agent>` result envelope, preserving failed/cancelled status and diagnostics across dashboard refreshes.

Both are ack-response RPCs following the same pattern as `bg:list` / `fs:list_dirs`.

## 6. Agent types

Agent types are named `(systemPrompt, allowedTools?, model?, description)` bundles resolved at spawn time. Definition sources, in priority order (higher wins on name collision):

1. **Inline in the `agent` tool call** — the parent passes `{ agent_type: 'researcher' }` and the type is looked up in the registry. If `agent_type` is omitted, we use a generic fallback ("general-purpose" — same system prompt as the parent, all tools).
2. **Workspace-local** — `.kala/agents/<name>.md` (walked up from `cwd`). Frontmatter + body, like Claude Code.
3. **User-global** — `~/.config/kala/agents/<name>.md`.
4. **Built-ins** — a small set shipped in `packages/host/src/agent-types/*.md`, initially just `general-purpose`, `Explore`, `Plan` for parity with the reference designs.

Frontmatter schema:

```yaml
---
name: string                    # canonical id, must match filename
description: string             # one-line, shown to the LLM in tool schema
model: string?                  # optional model override
tools: string[]?                # allowlist by tool name
disallowedTools: string[]?      # denylist (applied after allowlist)
maxTurns: number?               # cap child loop turns (default: inherit)
---
```

Body = system prompt.

**Loading**: on startup, `packages/host/src/agent-registry.ts` walks the three paths and constructs an in-memory `Map<name, AgentTypeDefinition>`. On file change (fs.watch), it reloads. Missing files simply reduce the registry.

**Advertising to the LLM**: the `agent` tool's `description` field is regenerated at registry-load time to enumerate the available types, e.g.:

```
Spawn a sub-agent to handle a focused sub-task. Available agent_type values:
  - general-purpose (default): general reasoning + all tools
  - Explore: fast read-only research (no write/edit/bash tools)
  - Plan: architectural planning; produces a plan, does not execute
  - <workspace-local types loaded from .kala/agents/>
```

This keeps the LLM oriented without needing per-type separate tools (Claude Code's pattern of exposing each type as its own tool inflates the tool schema for the parent).

**Merging at spawn**: `runAgentTool()` currently constructs `filteredAgentConfig(parent.config, effect.input.tools)`. We extend it to:

1. Look up the requested `agent_type` (if any) in the registry.
2. Merge type-level `systemPrompt`, `tools`, `model`, `maxTurns` on top of the parent config.
3. Apply the per-call `tools` array as a further intersection (never expansion — a call cannot re-enable tools the type denies).
4. Apply per-call `model` on top (per-call wins).

## 7. Dashboard UX

### Inline card

When the parent's timeline contains one or more adjacent `tool_call`s for `agent`, the chat panel renders one grouped `SubAgentCard` activity instead of one generic Tool row per child. This grouping is based on the parent turn's adjacent Agent calls, not on how a Runtime happens to split those calls across assistant messages.

The group presents each child as a readable row inside one shared container. It does not use a card matrix: parallel children are a single activity that operators scan vertically. Each child has three modes:

- **Pending** — before `server:sub_agent_started` arrives (rare — usually milliseconds). Shows spinner + "Spawning sub-agent…".
- **Running** — after started, before finished. Header shows the agent type, task prompt, elapsed time, turn count, and interrupt action. The live body is open by default. Small transcripts use natural height; only long transcripts switch to a bounded virtual viewport.
- **Completed / Failed / Cancelled** — after `server:sub_agent_finished`. Header shows final status + duration + turn count. Body still collapsible; failed and cancelled cards open by default so the reason is visible.

The default surface prioritizes the task, progress, and result. Resolved policy internals such as allowed tools, max turns, timeout budgets, depth/fan-out, and resolution reasons live under a closed **Execution details** disclosure. They are diagnostic settings, not primary transcript content.

The inline child transcript uses a compact read-only renderer over the same normalized `Message` model. If the live child transcript is unavailable after completion, the parsed `<result>` envelope is the durable fallback.

For Copilot-runtime children, a turn that produces no meaningful assistant, usage, tool, error, or idle event within five minutes is aborted as a failed child. Internal `user.message` and `assistant.turn_start` bookkeeping events do not count as progress. After meaningful activity begins, the existing 30-minute inactivity window applies. The resulting failure envelope is returned to the parent like any other failed child.

### Composer hint

The Composer's `@` menu is extended: `@agent-name` autocompletes from the registry (fetched via `agent_types:list`), and expands to a directive that the parent LLM can (but is not forced to) turn into an `agent` tool call. This is a nudge, not a mechanism — same as `@file` today.

### Explorer indicator

Sessions with `parentSessionId !== null` already appear indented under their parent in Explorer (we have "fork of…" text). Two small changes:

- Distinguish "sub-agent" child from "fork" child by looking at whether the parent's log contains an `agent` tool_call with `callId` = the child's origin. The child record already tracks this via `parentCursor`.
- Add an `agent_type` badge next to the child's title.

## 8. Lifecycle end-to-end

1. **Parent turn.** LLM emits `tool_call { name: 'agent', callId: X, input: { prompt, agent_type?, model?, tools? } }`.
2. **Host loop** (`loop.ts:317`) sees `AGENT_TOOL_NAME`, calls `runAgentTool()`.
3. **`runAgentTool()`**:
   a. Depth check.
   b. Resolve agent type (new): look up in registry, merge into config.
   c. `SessionStore.create()` for the child.
   d. **Emit `server:sub_agent_started`** into the parent's room (new).
   e. `dispatchOne(child, { user_message, text: prompt })`. This runs a full inner loop, emitting `event:appended` / `state:changed` events into the child's own room, which the dashboard is already subscribed to.
   f. On completion, wrap the child's final text in the `<sub_agent>` envelope.
   g. **Emit `server:sub_agent_finished`** into the parent's room (new). Interrupted children use `status: 'cancelled'`.
   h. Return the envelope as `{ ok, content }`.
4. **Loop** feeds the tool_result back into the parent's kernel as a normal `tool_result` event. Parent LLM receives the enveloped text on the next `call_llm` effect.
5. **Dashboard**:
   - On `sub_agent_started`, mark the parent's SubAgentCard as running and open a subscription to the child session.
   - Coalesce adjacent Agent calls from the same parent activity even when an external Runtime projected each call as a separate assistant message.
   - Render child's `event:appended` events inline via a nested `<ChatPanel readOnly>`.
   - On `sub_agent_finished`, freeze the card.
   - Later, when the parent's timeline reloads (e.g. after refresh), the envelope in the `tool_result` content lets the card reconstruct itself without needing the live events — `sub_agent:list` RPC gives it the child session ids to fetch on-demand.

## 9. Failure modes

- **Child times out or errors** — `runAgentTool()` returns `{ ok: false, content }` with a failed envelope. The parent kernel treats it as a normal tool failure. The dashboard shows the card in `failed` state.
- **Depth exceeded** — same, immediate failure envelope. No child session created (so no `sub_agent_started` event). This is the only path where the card renders "immediately failed" without any live-run state.
- **User interrupts child from the parent card** — the host marks the active sub-agent as cancelled, dispatches `cancel` to the child session, emits `server:sub_agent_finished` with `status: 'cancelled'`, and returns a cancelled envelope to the parent as a normal failed tool result.
- **Host restart mid-child** — child's JSONL log exists; on rehydrate we replay it as a normal session. If it was mid-tool-call, the fold's crash-recovery synthesizes a `tool_error` event, and the child ends up in `error` state. The parent's `agent` tool_call is still pending in the parent's log; on rehydrate the parent kernel synthesizes a matching `tool_error` and the parent LLM gets a failure envelope on its next turn.
- **User rewinds child via `session:fork`** — normal fork behavior. The parent's `tool_result` still points to the pre-fork session id via the envelope; the forked session gets a new id and does not affect the parent's log.
- **User cancels parent while child is running** — parent cancellation cascades to active child sessions owned by that parent. Each child receives a normal loop `cancel`, so in-flight LLM/tool work is aborted by the same machinery as top-level cancellation. The parent receives a cancelled sub-agent envelope.

## 10. Testing plan

- **Kernel**: no new tests (no reducer changes).
- **Host**:
  - `agent-tool.test.ts` extension: agent-type resolution merges correctly (type + per-call `tools` = intersection).
  - `agent-registry.test.ts`: loading from disk, precedence order, hot reload.
  - `agent-tool.test.ts`: emits `sub_agent_started` and `sub_agent_finished` in the right order with the right payloads, including `cancelled` for parent-cancel cascade.
- **Dashboard**:
  - `SubAgentCard.test.tsx`: renders pending/running/completed/failed/cancelled states from prop inputs and emits `client:interrupt_sub_agent` for a running child.
  - `SubAgentCard.test.tsx`: verifies adjacent external-Runtime Agent projections become one grouped activity, policy diagnostics are closed by default, and small live transcripts remain content-height.
  - `useSubAgentSession.test.tsx`: acquires/releases the multiplexed `session:<childId>` channel and mirrors `session:ready` / `state:changed`.
  - Envelope parser: handles happy path, malformed envelopes, and legacy pre-envelope tool_results (fall back to plain text).
- **Integration**: an end-to-end test in the host suite spawns a mock child, drives one tool_call turn, asserts both events land and the envelope round-trips.
- **Browser layout**: verify readable computed font sizes, one group container for parallel children, and no fixed-height blank viewport for a sparse running transcript.

## 11. Non-goals for this pass

- **Background sub-agents** (Codex-style `spawn_agent` returning immediately). Nice-to-have; not now.
- **Custom sub-agent tool schemas** (Claude Code exposes each agent type as its own tool with tailored input). We keep a single `agent` tool with `agent_type` as an argument. Simpler prompt for the parent.
- **Per-agent-type MCP server allowlisting.** MCP integration is TBD project-wide.
- **Background sub-agent resume/follow-up** (Codex `send_message`/`wait_agent`). Current children are foreground tool calls with live observation and interruption only.

## 12. Open questions

- Should the envelope escape `<`/`>` inside the child's final text? YES — otherwise a child that returns HTML/XML confuses the parser. Use HTML entities in `<result>`.
- Should we cap the inline child transcript at N tokens/messages? Probably YES for very long children (>50 turns) — a "show all" button expands to full.
- Should the parent LLM see the child's tool calls in its own context? NO — that's the whole point of the isolation. Only the wrapped text.
