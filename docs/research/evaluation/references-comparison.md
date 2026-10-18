# Reference Projects Comparison: Agent Kernel Design Analysis

**Date**: July 4, 2026
**Projects Analyzed**: pi (67k stars), opencode (production-grade Go+TS), codex (OpenAI CLI), clawspring (Claude Code reimplementation)

---

## Comparison Table

| Axis | pi (earendil-works/pi) | opencode (sst/opencode) | codex (openai/codex) | clawspring (chauncygu) |
|------|---|---|---|---|
| **1. Agent Loop Location & Size** | `/packages/coding-agent/src/core/agent-session.ts` lines 1–3175 (~3.2K LOC). Embedded in class; uses `Agent` from `@earendil-works/pi-agent-core`. Subscribers model: `subscribe(listener)` → emits events. | `/packages/opencode/src/agent/agent.ts` lines 1–453 (~0.45K LOC). Effect-based pure function. Uses `Effect.gen()` for computation abstraction. Agents are configs, not loops. | `/sdk/typescript/src/thread.ts` lines 65–139 (~75 LOC for main loop). Async generator `runStreamedInternal()`. External Rust binary (`@openai/codex`) drives loop. | `/clawspring/agent.py` lines 55–151 (~100 LOC). Generator function `run()`. Python generator yields events. While-true loop with permission gates. |
| **2. Loop Shape** | **Async class with event-driven subscribers.** Hybrid: internal `Agent` (from pi-agent-core) has its own loop. Session wraps it. `while`-loop inside Agent, external subscribe pattern for session. | **Effect monad (FP-style state machine).** Uses Effect framework. No explicit while-loop; state transitions via Effect combinators. Configuration-driven agent factory. | **Async generator (SDK wrapper).** `async *runStreamedInternal()` wraps native Codex binary. Thin TypeScript shim over child process. | **Python generator (classic while-true).** `yield` events. Simplest shape: straightforward imperative control flow. |
| **3. State Representation** | **Stateful class + event log.** `AgentSession` class with properties: `agent`, `sessionManager`, `settingsManager`, `_steeringMessages[]`, `_pendingNextTurnMessages[]`, `_toolRegistry`, `_retryAttempt`. State from `this.agent.state` (from pi-agent-core: `{ model, messages, tools, isStreaming, ... }`). Also persists to JSONL. | **Immutable config + Effect context.** `Agent.Info` schema (Struct): `{ name, description, permission, model, ... }`. Permission is layered (defaults + user overrides). No mutable state in agent config itself; state lives in Effect Context/Service layer. | **Thin wrapper, state in Codex binary.** Thread class: `{ _exec: CodexExec, _id, _threadOptions }`. Actual state (messages, context) lives in native binary process. TypeScript SDK has minimal state. | **Dataclass `AgentState`: `{ messages[], total_input_tokens, total_output_tokens, turn_count }`**. Plain data, no methods. Immutable-ish (mutated by `run()` generator). No persistence layer shown in agent.py. |
| **4. Tool Schema Format** | **TypeScript `ToolDefinition<Input, Output>` interface.** See `/core/tools/index.ts` lines 96–166. Tool registry: `Map<string, { definition, sourceInfo }>`. Schemas derived from zod-like typed generics. Tools: read, write, edit, bash, grep, find, ls (7 total). | **Vercel AI SDK `Tool` type via `generateObject(), streamObject()`.** Implicit schema inference from Zod or TypeScript types. No explicit registry shown; tools are passed as parameters to agent executor. | **Schema passed via `--output-schema` file (JSON Schema).** Binary-driven; TypeScript just serializes. Approval modes as enum: `{ auto, ask, always_deny }`. | **Plain dict-based schema.** Tool registry via global import: `from tools import execute_tool`. Schemas registered at module load time. No explicit schema objects; execution via string dispatch. |
| **5. Built-in Tools** | **read, write, edit, bash, grep, find, ls** (7 tools, all file/bash-focused). Can be disabled per-session via `noTools`, `excludeTools`. Tool creation in `/core/tools/index.ts`. Extensible via `customTools` option. | **Depends on agent config, but core includes: read, write, glob, grep, web_search, web_fetch, ext_directory, plan, todowrite.** Each tool has permission gating. Plan/todo tools are special (affect agent mode). | **Codex binary-driven.** TypeScript SDK doesn't enumerate tools; Rust binary provides them. Likely includes: exec, read, write, web_search based on config. Approval modes: auto/ask/always_deny per tool. | **read, write, bash, glob, grep, web_fetch, web_search, Agent (subagent spawner).** Registered in `/tools.py` via `BUILTIN_TOOLS` dict. Tools are functions, registered by name. Includes subagent delegation. |
| **6. Approval / Permission Mechanism** | **Two-tier: `extensionRunner.emit("approval_request")` and session-level `permission_mode`**. Uses pi-ai's internal approval. Tools gate via extension hooks. Permission model: "ask", "accept-all", or per-extension custom. Session-wide override possible via `settingsManager`. | **Layered permission system via `Permission` class.** `Permission.merge(defaults, user_overrides)`. Permission has rules: `{ "*": "allow", "edit": { "*": "deny", ".opencode/*": "allow" }, ... }` (glob patterns). Per-agent permission set (e.g., "build" vs "plan" agent has different rules). Checked during tool dispatch. Tiers: defaults < user < agent. | **Approval modes: auto, ask, always_deny.** Passed as `--config approval_policy=auto` to Codex binary. Codex handles approval UI/persistence. TypeScript SDK is pass-through. | **Three-mode: "auto" (safe ops OK), "manual" (ask always), "accept-all" (never ask).** `_check_permission(tc, config)` returns bool. Yields `PermissionRequest(description, granted)` event; caller decides if `granted = True`. No persistence; per-session. |
| **7. Baked into Kernel vs External** | **Inside loop: compaction (auto-threshold + manual), retry logic, steering/follow-up queue, thinking level switching, context overflow detection.** Outside: planning (handled by user/extensions), long-term memory (CLAUDE.md not in core, but session hooks exist for extensions). Session persistence is inside (JSONL format). Subagent delegation via extensions only. | **Outside kernel: planning, memory, subagent.** Inside Effect context: permission, model selection, tool registry. Compaction: not visible in agent.ts; likely in extension layer. Thinking level: model-specific config, not in agent loop. Session persistence: not shown in agent.ts; external. | **Outside kernel (Codex binary):** approval, context overflow, compaction, retry, session persistence. TypeScript SDK is thin; all logic in Rust binary. Inside SDK: thread state management, event streaming. | **Inside loop: permission checks, retry (implicit via while-true), maybe_compact() call.** Outside: CLAUDE.md-like memory (separate memory/ module), provider-specific behavior (in providers.py, called from agent.py). Subagent spawning is separate tool. Session persistence not shown. |
| **8. Provider Abstraction** | **Via `@earendil-works/pi-ai` package (abstracted out of view).** Agent uses `Model<T>` type with `.reasoning` support. Model registry detects provider (Anthropic, OpenAI, Google, etc.). Request config layering for auth/headers/env. Thinking level clamped per provider capability. | **Vercel AI SDK** (`import { generateObject, streamObject } from "ai"`). Provider abstraction at Vercel layer; no direct Anthropic/OpenAI imports in agent.ts. Model type: `ModelV2 { providerID, modelID }`. Provider-specific quirks in ProviderTransform. | **Single provider: OpenAI.** Codex binary uses OpenAI API directly. No abstraction for other providers visible in TypeScript SDK. Binary handles auth, baseUrl override, API key. | **Multi-provider via function dispatch.** `detect_provider(model_name)` in providers.py. Each provider has `stream(model, ...) → Generator[AssistantTurn]`. No interface; just duck-typed generator functions. Detects: Anthropic, OpenAI, Google, others. Request formatting per provider. |
| **9. Session Persistence / Replay** | **JSONL format, one entry per event.** File: `${timestamp}_${sessionId}.jsonl` (e.g., `2024-01-15T10:30:00Z_abc123.jsonl`). Entry types: message, model_change, thinking_level_change, compaction, branch_summary, custom. Fork support: `SessionManager.forkFrom(sourcePath, cwd)` → new session with parent ID. Replay: implicit (re-folding entries would reconstruct state, not yet implemented). Session versioning: `CURRENT_SESSION_VERSION = 3`. | **Session persistence not shown in agent.ts**; external infrastructure. Effect-based design implies immutable event sourcing *could* work but not demonstrated. Agent configs are JSON (can be versioned). Fork/replay: not visible in code snippet. | **Codex binary handles persistence.** TypeScript SDK calls `resumeThread(threadId)` → passes `threadId` to Codex binary. Binary stores sessions in `~/.codex/sessions/`. No direct JSONL inspection possible from SDK. Fork: not shown. Replay: implicit (binary resumes from stored state). | **Session file format not shown in agent.py.** Memory module (separate) handles persistence. No fork/replay visible in core loop. Events are transient (yielded, not stored). |
| **10. UI Form** | **TUI (Terminal User Interface).** Built with `@earendil-works/pi-tui` package. Interactive mode, print mode, RPC mode. Main entrypoint in `/src/modes/interactive/interactive-mode.ts`. Input: stdin, output: styled terminal. React-like component model (TUI framework, not React). Also supports non-interactive modes (print, RPC). | **Console app + dashboard (not visible in agent.ts).** Infra file (`/infra/app.ts`) suggests Lambda/web backend. Agent is headless service. Frontend likely web-based (React or similar), separate from agent. | **CLI tool (OpenAI/Codex).** TypeScript SDK is library; no UI. Codex binary has own TUI (Rust). TypeScript SDK wraps binary output. | **CLI only.** No TUI. Outputs to stdout/stderr. REPL-style interaction. Python-based, no fancy UI framework. Memory module has web output but not in core agent loop. |
| **11. Transport (if multi-process)** | **Single process (Node.js, TUI runs in same process).** Internal message passing via subscribers. Session manager writes to disk (JSONL). No cross-process communication shown. RPC mode uses stdin/stdout (JSON-RPC). | **Multi-service backend (inferred from infra/).** Agent service + Console + Web. Transport likely HTTP/gRPC (not shown in agent.ts). Host agent is headless. | **Multi-process: TypeScript SDK ↔ Codex binary.** Transport: child_process stdio + JSON events. SDK spawns Codex binary, writes input to stdin, reads JSON events from stdout. Approval flow requires human interaction (stdin prompt in binary). Resume uses thread file references (shared filesystem). | **Single process (Python).** Generators yield events; caller (REPL or web wrapper) consumes. If multi-process needed, orchestrated externally. No IPC shown. |

---

## Kernel Design Lessons

### 1. **Loop Shape Matters for Replay/Fork**
pi's event log (JSONL) + pure entry types (message, model_change, compaction, etc.) enable replay in principle (entries can be re-folded). clawspring's imperative while-loop with generator yields is simpler to write but harder to replay (no event log). **Lesson**: Use immutable, timestamped events as the canonical storage. Make the loop a pure function over event stream: `fn(events: Event[], new_user_input) → (state', events')`.

### 2. **Separate Agent Config from Agent State**
opencode's distinction is sharp: `Agent.Info` (config, immutable) vs service context (state, mutable in Effects). pi conflates them in `AgentSession` class. **Lesson**: Agent kernel should be `fn(config: AgentConfig, state: AgentState, user_input) → (state', output)`. Config is data; state is runtime. Don't mutate config during loop.

### 3. **Permission Gating Belongs Outside the Host Loop**
All four projects handle permissions, but placement varies:
- pi: inside Agent (via pi-agent-core), wrapped by extension hooks
- opencode: outside (per-agent config via Permission.merge)
- codex: outside (approval_policy passed to binary)
- clawspring: inside loop (permission_mode check before tool execution)

**Lesson**: Permission gate should be a **middleware function** applied *after* tool selection, *before* execution: `if gate(tool, config.permission) then exec(tool) else yield PermissionRequest`. Keep gate logic out of the loop's critical path.

### 4. **Session Persistence Format: Immutable Event Log (JSONL) > Mutable State Files**
pi's JSONL (one entry per turn/event) is append-only and replay-friendly. If clawspring or codex serialize mutable state, replay is non-deterministic. **Lesson**: Canonical storage = immutable event log. Each entry: `{ type, id, parentId, timestamp, data }`. Turn a session into a new branch by appending a "fork" marker entry + starting a new session file.

### 5. **Provider Abstraction Must Hide Model-Specific Quirks**
pi's `Model<T>` with `.reasoning` property, opencode's Vercel AI SDK, clawspring's duck-typed `stream()` function—all work, but at different abstraction levels. None of them fully hide provider differences (thinking levels, cache format, tool schemas). **Lesson**: Define a normalized `Message` type that's provider-independent. Provider adapter translates to/from native format. Hide `cacheControlFormat: "anthropic"` or `reasoning: true` behind `thinkingLevel: "deep"`.

### 6. **Compaction Should Not Be in the Host Loop**
pi has compaction baked in (auto-threshold + extension hooks). opencode/codex/clawspring don't show it clearly. **Lesson**: Compaction is a *side effect*, not part of the pure loop. Make it an optional post-turn hook: `after each turn, if shouldCompact(state), emit CompactRequest`. Extension/outer layer decides if/how to compact. Loop just detects context overflow.

### 7. **Subagent Delegation / Tool Nesting Must Be Explicit**
clawspring has an "Agent" tool that spawns child agents (depth tracking). pi/opencode/codex don't clearly show subagent structure. **Lesson**: Nesting depth should be a first-class parameter: `depth: 0 (main) | 1+ (subagent)`. Subagent invocation is a tool call that yields a new generator/result. Don't hide it in recursion.

### 8. **Steering & Follow-up Messages Are UI Concerns, Not Kernel**
pi tracks `_steeringMessages[]` and `_followUpMessages[]` inside the session. These are UI state (pending on-screen messages), not core loop state. **Lesson**: Queue mode (steering/follow-up) should be external config passed to the loop, not internal state. Output a `queue_update` event; let the UI consume it.

### 9. **Token / Context Tracking Should Be Observable, Not Hardcoded**
clawspring tracks `total_input_tokens`, `total_output_tokens` in `AgentState`; pi wraps it via events. codex/opencode don't show token tracking in agent code. **Lesson**: Emit usage/context signals as observable state. Let observers (CLI, web dashboard, plugins) decide what to do (log, prompt, compact). Do not expose or hardcode token cost / money metrics in the product UI.

### 10. **RPC/Multi-Process Communication Should Be Event-Based**
pi's RPC mode uses JSON-RPC over stdin/stdout; codex uses child_process + JSON events. **Lesson**: If splitting kernel from UI/executor, serialize the event stream (each turn yields events that can be JSON-stringified). Send over WebSocket, HTTP, or raw socket. Receiver replays events to update local state.

---

## Comparative Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           AGENT-KERNEL DESIGN SPACE                         │
└─────────────────────────────────────────────────────────────────────────────┘

LOOP SHAPE:
  pi              → Class + Subscribers (event-driven, internal pi-agent-core loop)
  opencode        → Effect Monad (functional, configuration-driven)
  codex           → Async Generator wrapping Rust binary (thin SDK)
  clawspring      → Generator + while-true (imperative, simplest)
  ➜ RECOMMENDATION: Pure function over events, replay-friendly

STATE REPRESENTATION:
  pi              → Mutable class + JSONL event log
  opencode        → Immutable config + Effect context
  codex           → Native binary state, thin SDK wrapper
  clawspring      → Plain dataclass, no persistence
  ➜ RECOMMENDATION: Immutable state + append-only event log

PERMISSION GATING:
  pi              → Inside loop (extension hooks)
  opencode        → Config layer (Permission.merge)
  codex           → Outside (approval_policy flag)
  clawspring      → Inside loop (permission_mode check)
  ➜ RECOMMENDATION: Middleware function, applied before tool exec

TOOL REGISTRY:
  pi              → TypeScript interface, ~7 built-in tools
  opencode        → Vercel AI SDK, implicit schema
  codex           → Rust binary, config-driven
  clawspring      → Python dict dispatch, ~8 tools
  ➜ RECOMMENDATION: JSON Schema per tool, registry module, pluggable

SESSION PERSISTENCE:
  pi              → JSONL (immutable log), fork support, replay-ready
  opencode        → Not shown in agent code
  codex           → Rust binary (threadId reference), session dir
  clawspring      → Not shown in agent code
  ➜ RECOMMENDATION: JSONL immutable log, version marker, fork entry type

COMPACTION:
  pi              → Baked in (auto + manual)
  opencode        → Not shown
  codex           → Rust binary
  clawspring      → Called before streaming (maybe_compact)
  ➜ RECOMMENDATION: Post-turn hook, extension-driven, optional

PROVIDER ABSTRACTION:
  pi              → Model<T> + thinkingLevel + cache format
  opencode        → Vercel AI SDK
  codex           → OpenAI only
  clawspring      → Provider duck-type (stream generator)
  ➜ RECOMMENDATION: Normalized Message type, adapter pattern

MULTI-PROCESS TRANSPORT:
  pi              → stdin/stdout (RPC mode)
  opencode        → HTTP/gRPC (inferred)
  codex           → child_process stdio
  clawspring      → None shown
  ➜ RECOMMENDATION: WebSocket (Socket.IO) if async needed; else stdin/stdout

UI:
  pi              → TUI (@earendil-works/pi-tui)
  opencode        → Web dashboard (inferred)
  codex           → CLI + Rust TUI
  clawspring      → CLI only
  ➜ RECOMMENDATION: Decouple kernel from UI; use event stream; React SPA or Rust TUI

BUILT-IN TOOLS (INTERSECTION):
  ✓ read, bash, write, edit, grep, find, ls (file/code focused)
  ✓ web_fetch, web_search (optional)
  ✗ plan/todo, subagent (domain-specific, extension territory)
  ➜ RECOMMENDATION: v1 core: {read, bash, write, edit, grep, find, ls}
```

---

## Specific Lines of Code References

| Project | File | Lines | Purpose |
|---------|------|-------|---------|
| **pi** | `/packages/coding-agent/src/core/agent-session.ts` | 1–3175 | Main session class; event subscription, compaction, retry |
| **pi** | `/packages/coding-agent/src/core/session-manager.ts` | 780–1500 | JSONL persistence, fork, replay structure |
| **pi** | `/packages/coding-agent/src/core/tools/index.ts` | 96–196 | Tool registry and creation factories |
| **opencode** | `/packages/opencode/src/agent/agent.ts` | 1–453 | Effect-based agent config and permission layers |
| **opencode** | `/packages/opencode/src/tool/registry.ts` | (check file) | Tool registry (Effect-based) |
| **codex** | `/sdk/typescript/src/thread.ts` | 70–139 | Main loop: `runStreamedInternal()` async generator |
| **codex** | `/sdk/typescript/src/exec.ts` | 86–200 | Child process spawn and JSON event parsing |
| **clawspring** | `/clawspring/agent.py` | 55–151 | Pure generator loop, permission gating |
| **clawspring** | `/clawspring/tools.py` | 887+ | Tool execution dispatch |

---

1. **pi (3.2K LOC)**: Too fat. Embeds compaction, retry logic, multiple modes (interactive/print/RPC), steering queues, thinking level management. Depends on external pi-agent-core package (black box). Not replay-first by design.

2. **opencode (0.45K LOC)**: Minimal, but Effect monad abstraction is heavy for newcomers. No explicit session persistence shown. Permission model is powerful but complex. Not a standalone kernel; part of larger system.

3. **codex (75 LOC SDK)**: Excellent minimalism, but *all* logic is in Rust binary (not visible). TypeScript SDK is just a thin wrapper. Not a teaching tool; can't understand it without Rust code.

4. **clawspring (100 LOC loop)**: Simplest, but no session persistence, no replay, no multi-process comm. Excellent for "baby's first agent loop" but incomplete for production.

---

## Recommended v1 Kernel (~300–500 LOC)

```
agent-kernel/
├── core.ts (pure function)
│   ├── type State = { messages[], model, tools, context_tokens }
│   ├── type Event = Message | ToolCall | ToolResult | CompactRequest | ...
│   ├── fn loop(state, userInput, config) → Generator<Event>
│   └── Implements: while (not done) { call LLM, handle tool dispatch, yield events }
├── providers.ts (adapter)
│   ├── normalize(model, messages) → ProviderRequest
│   └── unnormalize(response) → { content, toolCalls, tokens }
├── tools.ts (registry)
│   ├── BUILTIN_TOOLS = { read, write, edit, bash, grep, find, ls }
│   └── fn execute(toolName, input) → result
├── session.ts (persistence)
│   ├── fn saveEvent(event) → append to JSONL
│   └── fn replay(sessionFile) → State
├── permission.ts (gating)
│   └── fn gate(tool, config) → boolean
└── events.ts (types)
    └── type Event = MessageEnd | ToolStart | ToolEnd | PermissionRequest | ...
```

**Key properties**:
- Pure function loop: `(state, input, config) → state' + events`
- All I/O (LLM, tools, disk) observable via events
- No mutable class state; config + state are parameters
- Provider abstraction: normalized Message type
- Persistence: append-only JSONL, one entry per event
- Permission: middleware, not in loop
- Subagent: recursive tool call (depth tracking)
- Fork: append "fork" event to new JSONL file

This design passes all three "first-class" requirements:
1. **Replay**: Events are immutable; re-folding them rebuilds state ✓
2. **Fork**: New session file with "fork" marker entry ✓
3. **Pure reducer**: Loop is `fn(state, input) → (state', events)` ✓

---

**Total Report Length**: ~2800 words (dense, no fluff)
