# Dashboard Agent Kernel Debugger

**Status**: design target for the right-side dashboard inspector.
**Scope**: `packages/dashboard/src/features/inspector/` plus optional host-side LLM trace metadata.

## 1. Purpose

The right sidebar is not a generic product activity feed. It is a teaching debugger for `agent-kernel`'s core claim:

```text
event in -> pure reducer -> next state + effects -> host/executor/LLM IO -> new event
```

The UI must make that loop readable without hiding the raw internals. A learner should be able to start with the state-machine trace, then drill into full JSON, tool lifecycle, memory, and LLM request/response data.

## 2. Design Constraints

- Preserve the current dashboard visual language. Follow `packages/dashboard/STYLE.md`: separate large surfaces by background luminance, avoid bare panel borders, and use `border-border/50` or `border-border/60` only for small internal frames.
- Keep this a debugger. Do not collapse everything into friendly summaries that obscure reducer state, effect names, event kinds, tool schemas, or `AgentState` JSON.
- Preserve existing capabilities: timeline, state flow, fork, jump to message, raw event/effects JSON, state JSON, tools, memory, and compaction details.
- Add a clear LLM-call view. Kernel-level LLM request/response is available today from `call_llm` effects and `llm_response` events. Provider-level HTTP body/response requires host adapter trace metadata and must redact credentials.
- Keep the kernel pure. Provider trace data is log/UI metadata next to the event entry, not a kernel event and not part of `AgentState`.

## 3. Information Architecture

```text
Agent Kernel Debugger
├─ Overview
│  └─ Status, event count, context usage, pending tool
├─ Sidebar Tabs
│  ├─ Debugger
│  │  └─ Runtime Objects
│  │     ├─ State
│  │     ├─ Tools
│  │     └─ Memory
│  └─ Trace View
│  ├─ Reducer Trace
│  ├─ LLM Calls
│  └─ Tool Calls
└─ Detail Modals
   ├─ Event summary + raw JSON
   ├─ LLM I/O for selected LLM calls/responses
   ├─ Tool lifecycle for selected tool calls
   ├─ Full AgentState JSON
   └─ Compaction request/result for compact events
```

## 4. Mock Session Data

All wireframes below use one concrete teaching session:

```text
sessionId: sess_20260706_cwd_fix
provider: anthropic
model: claude-sonnet-4-6
cwd: /path/to/agent-kernel
approvalMode: ask
status: executing_tools
cursor: 128
messages: 24
tools: 11
session memory entries: 2
usage.inputTokens: 42180
usage.outputTokens: 6180
contextLimit: 128000
```

## 5. Overall Layout

```text
┌────────────────────────────────────────────────────────────────────┐
│ Agent Kernel Debugger                                         #128 │
│ executing_tools · approval ask · anthropic/claude-sonnet-4-6       │
│ cwd /path/to/agent-kernel                                          │
├────────────────────────────────────────────────────────────────────┤
│ Overview                                                           │
│ ┌──────────────┬──────────────┬──────────────┬───────────────────┐ │
│ │ Status       │ Events       │ Context      │ Pending           │ │
│ │ executing    │ 128          │ 42180/128000 │ edit              │ │
│ └──────────────┴──────────────┴──────────────┴───────────────────┘ │
├────────────────────────────────────────────────────────────────────┤
│ [Debugger] [Trace View]                                            │
├────────────────────────────────────────────────────────────────────┤
│ Debugger                                                           │
│ [State] [Tools] [Memory]                                           │
│                                                                    │
│ current runtime object inspector                                   │
├────────────────────────────────────────────────────────────────────┤
│ Trace View                                                         │
│ [Reducer Trace] [LLM Calls] [Tool Calls]                           │
│                                                                    │
│ current trace view content                                         │
├────────────────────────────────────────────────────────────────────┤
│ Detail modal opens only after selecting an event/call or View JSON  │
└────────────────────────────────────────────────────────────────────┘
```

## 6. Trace Views

### 6.1 Reducer Trace

Reducer Trace merges the old `Timeline` and `State flow` tabs. Each row shows the reducer input, status transition, emitted effects, and row actions.

```text
┌────────────────────────────────────────────────────────────────────┐
│ Trace View                                                         │
│ [Reducer Trace] [LLM Calls] [Tool Calls]                           │
├────────────────────────────────────────────────────────────────────┤
│ Reducer Trace                                                      │
│ event in                         state transition         effects  │
│                                                                    │
│  #120 user_message               idle ───────────▶ thinking        │
│       source user                                      call_llm    │
│       text "Please fix executor relative paths so they follow cwd."     │
│                                                                    │
│  #121 llm_response               thinking ───────▶ awaiting_approval│
│       source llm                              request_approval     │
│       tool_call edit                                                   │
│       file packages/executor/src/sandbox.ts                            │
│                                                                    │
│▌ #122 user_approve              awaiting_approval ─▶ executing_tools│
│       source user                                      call_tool   │
│       callId toolu_01J4Z7K9V2N8Q5M3B1C6D0E4                         │
│       tool edit                                                      │
│       [jump chat] [fork here] [inspect json]                         │
│                                                                    │
│  #123 tool_result               executing_tools ─▶ thinking        │
│       source executor                                  call_llm    │
│       ok true                                                       │
│       content "Applied patch to packages/executor/src/sandbox.ts"   │
│                                                                    │
│  #124 llm_response              thinking ───────▶ done             │
│       source llm                                       finish      │
│       text "Fixed cwd-relative path resolution and added tests."        │
└────────────────────────────────────────────────────────────────────┘
```

### 6.2 LLM Calls

LLM Calls groups `call_llm` effects with the later `llm_response` or `llm_error`. This view is the primary answer to "what request did each LLM API call send and what response came back?".

```text
┌────────────────────────────────────────────────────────────────────┐
│ Trace View                                                         │
│ [Reducer Trace] [LLM Calls] [Tool Calls]                           │
├────────────────────────────────────────────────────────────────────┤
│ LLM Calls                                                          │
│ call                 provider/model                 status usage   │
│                                                                    │
│▌ #120 -> #121       anthropic / claude-sonnet-4-6   200    42180/614│
│   request 23 messages · 11 tools · stream true                     │
│   response tool_call edit                                          │
│   selected                                                         │
│                                                                    │
│  #123 -> #124       anthropic / claude-sonnet-4-6   200    43620/388│
│   request 25 messages · 11 tools · stream true                     │
│   response final text                                              │
│                                                                    │
│  #088 -> #089       anthropic / claude-sonnet-4-6   200    91200/740│
│   request compaction summarizer · 18 messages · 0 tools            │
│   response compact summary                                         │
└────────────────────────────────────────────────────────────────────┘
```

Selected LLM call detail:

```text
┌────────────────────────────────────────────────────────────────────┐
│ Selected Detail                                                    │
│ LLM Call #120 -> #121                                              │
│ [Kernel] [Provider] [Parsed]                                       │
├────────────────────────────────────────────────────────────────────┤
│ Kernel Request                                                     │
│ call_llm emitted by reducer at event #120                          │
│ model claude-sonnet-4-6 · messages 23 · tools 11                   │
│                                                                    │
│ Provider Request                                                   │
│ POST https://api.anthropic.com/v1/messages                         │
│ headers { "anthropic-version": "2023-06-01", "x-api-key": "test-redacted-api-key" }
│ body { "model": "claude-sonnet-4-6", "max_tokens": 4096, "stream": true }
│                                                                    │
│ Provider Response                                                  │
│ status 200                                                         │
│ stream events: message_start, content_block_start,                 │
│ content_block_delta, message_delta, message_stop                   │
│                                                                    │
│ Parsed Kernel Response                                             │
│ llm_response with tool_call edit and usage input=42180 output=614  │
└────────────────────────────────────────────────────────────────────┘
```

Provider Request/Response is shown only when `EventEntry.llmTrace` exists. Otherwise the view states that the current log contains kernel-level LLM I/O only. The selected model is read from `llmTrace.model` when present, then from `EventEntry.model`, so model labels remain available when provider HTTP capture is disabled.

### 6.3 Tool Calls

Tool Calls groups tool request, approval, dispatch, and result by `callId`.

```text
┌────────────────────────────────────────────────────────────────────┐
│ Trace View                                                         │
│ [Reducer Trace] [LLM Calls] [Tool Calls]                           │
├────────────────────────────────────────────────────────────────────┤
│ Tool Calls                                                         │
│ callId                            tool    approval   result        │
│                                                                    │
│▌ toolu_01J4Z7K9V2N8Q5M3B1C6D0E4 edit    approved   ok · 78 bytes  │
│   requested #121 · approved #122 · result #123                    │
│   path packages/executor/src/sandbox.ts                            │
│                                                                    │
│  toolu_01K8M3N5B7V2C9X4Z6A1S0D2 bash    approved   ok · 2840 bytes│
│   requested #125 · approved #126 · result #127                    │
│   cmd pnpm --filter @agent-kernel/executor test                    │
│                                                                    │
│  toolu_01P2Q3R4S5T6U7V8W9X0Y1Z2 read    auto       ok · 5240 bytes│
│   requested #117 · result #118                                    │
│   path packages/executor/src/client.ts                             │
└────────────────────────────────────────────────────────────────────┘
```

## 7. Runtime Objects

### 7.1 State

State shows compact grouped `AgentState` fields in the sidebar. The full JSON is still first-class debugger data, but it opens in a modal via `View JSON` so the right rail stays readable.

```text
┌────────────────────────────────────────────────────────────────────┐
│ Runtime Objects                                                    │
│ [State] [Tools] [Memory]                                           │
├────────────────────────────────────────────────────────────────────┤
│ State                                                              │
│ AgentState                                      [View JSON]        │
│ sess_20260706_cwd_fix                                             │
│ ┌────────────────────────────┬───────────────────────────────────┐ │
│ │ Core                       │ Workload                          │ │
│ │ status executing_tools     │ messages 24                       │ │
│ │ cursor 128                 │ todos 3                           │ │
│ │ approval ask               │ pending edit · dispatched         │ │
│ │ cwd /path/to/repo          │ context pressure soft             │ │
│ ├────────────────────────────┼───────────────────────────────────┤ │
│ │ Usage                      │ Memory                            │ │
│ │ input 42180                │ session entries 2                 │ │
│ │ output 6180                │ keys project_goal,                │ │
│ │ cache read 32000           │ ui_debugger_preference            │ │
│ └────────────────────────────┴───────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘

After clicking `View JSON`:

┌────────────────────────────────────────────────────────────────────┐
│ AgentState JSON                                             Close  │
├────────────────────────────────────────────────────────────────────┤
│ Full AgentState JSON                                               │
│ {                                                                  │
│   "sessionId": "sess_20260706_cwd_fix",                         │
│   "status": "executing_tools",                                  │
│   "messages": [                                                   │
│     { "role": "system", "content": [{ "type": "text", "text": "You are Codex..." }] },
│     { "role": "user", "content": [{ "type": "text", "text": "Please fix executor relative paths so they follow cwd." }] }
│   ],                                                               │
│   "pendingCalls": [{ "callId": "toolu_01J4...", "name": "edit", "status": "dispatched" }],
│   "cwd": "/path/to/agent-kernel"
│ }                                                                  │
└────────────────────────────────────────────────────────────────────┘
```

### 7.2 Tools

Tools uses a list/detail object inspector. The list stays compact; the selected tool shows schema and recent call references.

```text
┌────────────────────────────────────────────────────────────────────┐
│ Runtime Objects                                                    │
│ [State] [Tools] [Memory]                                           │
├────────────────────────────────────────────────────────────────────┤
│ Tools                                                              │
│ ┌────────────────────────────┬───────────────────────────────────┐ │
│ │ Registered Tools           │ Tool Detail                        │ │
│ │ read          auto         │ name edit                          │ │
│ │ ls            auto         │ approval required                  │ │
│ │ grep          auto         │ description Replace exact text in  │ │
│ │ bash          gated        │ a workspace file.                  │ │
│ │ edit        ▌ gated        │ Recent calls                       │ │
│ │ write         gated        │ #121 requested                     │ │
│ │ todo_graph     auto         │ #122 approved                      │ │
│ │ memory        auto         │ #123 result ok                     │ │
│ │ todo_graph     auto         │ Input Schema                       │ │
│ │ agent         gated        │ { "type": "object", "required": ["path"] }
│ └────────────────────────────┴───────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

### 7.3 Memory

Memory is an object inspector for session/workspace/global scopes. Session entries are in `AgentState`; workspace/global scopes are marked as executor-owned disk state unless fetched by a future API.

```text
┌────────────────────────────────────────────────────────────────────┐
│ Runtime Objects                                                    │
│ [State] [Tools] [Memory]                                           │
├────────────────────────────────────────────────────────────────────┤
│ Memory                                                             │
│ ┌────────────────────────────┬───────────────────────────────────┐ │
│ │ Scopes                     │ Entries                           │ │
│ │ session   ▌ 2 entries      │ key project_goal                  │ │
│ │ workspace   on disk        │ updated 2026-07-06 14:22:18       │ │
│ │ global      on disk        │ content Keep kernel pure; host    │ │
│ │                            │ owns LLM/event log; executor owns │ │
│ │                            │ workspace tools.                  │ │
│ │                            │ key ui_debugger_preference        │ │
│ │                            │ updated 2026-07-06 14:41:03       │ │
│ │                            │ content Show reducer transitions  │ │
│ └────────────────────────────┴───────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

## 8. Visual Rules

- The inspector root uses a quiet dashboard surface. Section separation uses spacing and subtle background steps, not hard full-width borders.
- Tab controls use compact segmented buttons, matching existing dashboard controls.
- Trace rows use hover background and a 2px selected accent rail. They do not need card borders.
- Small data tables may use `bg-muted/30` or `bg-background/60` cells and `border-border/50` internal frames.
- Raw JSON blocks keep their existing `JsonBlock` behavior and should be collapsed by default where data is large. Large raw details open in modals, not inline in the already narrow sidebar.
- Status colors are semantic only: amber for approval/waiting, emerald for success, rose for error, violet for LLM, sky for user/kernel info.

## 9. Implementation Notes

- Extend dashboard `TimelineEntry` with optional `llmTrace` and `model` metadata from log entries.
- Add `LLMTrace` to `@agent-kernel/shared` log/protocol types.
- Extend `LLMResponse` to optionally include `trace`. The host loop passes this to `SessionStore.record()` only for the resulting `llm_response` event.
- Redact all authorization headers before storing traces.
- For streaming providers, store a compact provider trace: request URL/headers/body, response status, stream event type list, assembled provider body when available. Avoid logging every token-sized raw chunk indefinitely unless the event stream is compact enough.
- Existing logs without `llmTrace` still render kernel-level LLM I/O; existing logs without `model` fall back to provider request-body inference or `model unknown`.
