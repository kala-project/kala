# Kernel Specification

**Package**: `@agent-kernel/kernel`
**Version**: v0.1
**Status**: Normative. This document is the authoritative contract for what the kernel does. If implementation and spec disagree, the spec is right and implementation is buggy.

---

## 0. Reading this doc

This spec is written so that a competent developer (or code agent) can re-implement the kernel from scratch and produce bit-identical behavior on the same event stream. It defines:

- **Types** (§1): the shape of every piece of data
- **Reducer contract** (§2): the pure function signature and its guarantees
- **State machine** (§3): valid states and legal transitions
- **Event handling** (§4): what each event does in each status
- **Invariants** (§5): properties that must always hold
- **Fold / Fork** (§6): replay and branching semantics
- **What the kernel deliberately does NOT do** (§7)
- **Verification contract**: the exact proof claims, assumptions, and
  non-claims are defined in [Kernel verification](../../development/testing/kernel-verification.md)

The reference implementation lives in `packages/kernel/src/`. Every claim below can be verified against `core.test.ts`.

---

## 1. Types

All types are structural (TypeScript `type`, not `class`). Everything is plain JSON-serializable data.

### 1.1 Message

```ts
type Role = 'system' | 'user' | 'assistant' | 'tool'

type TextContent = {
  type: 'text'
  text: string
}

type ImageSource =
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'file_ref'; path: string; mediaType?: string }

type ImageContent = {
  type: 'image'
  source: ImageSource
}

type ToolCallContent = {
  type: 'tool_call'
  callId: string                    // globally unique within a session
  name: string                      // must match a ToolSchema.name in AgentConfig.tools
  input: Record<string, unknown>    // must satisfy tool.inputSchema (kernel does not validate)
}

type ToolResultContent = {
  type: 'tool_result'
  callId: string
  ok: boolean                       // true = tool succeeded, false = error/rejection
  content: string                   // stringified result; encoding is host's responsibility
}

type ThinkingContent = {
  type: 'thinking'
  text: string
  signature?: string
}

type MessageContent = TextContent | ImageContent | ThinkingContent | ToolCallContent | ToolResultContent

type Message = {
  role: Role
  content: MessageContent[]
}
```

**Constraints:**
- A message with `role: 'system'` MAY appear at most once, and only as `messages[0]`.
- `role: 'user'` messages MAY contain `TextContent` and/or `ImageContent`.
- `role: 'assistant'` messages contain `TextContent` and/or `ToolCallContent`.
- `role: 'tool'` messages contain only `ToolResultContent`.

`ImageContent.source.kind` distinguishes inline base64 payloads (`base64`, with `data` and `mediaType`) from workspace-relative file references (`file_ref`, with `path` and optional `mediaType`). The kernel treats image blocks as opaque: they are appended, folded, and forwarded to `call_llm` unchanged; providers that do not support vision are the host's problem. `ThinkingContent` is also opaque reducer data, preserved so adapters that require thinking-block echo can round-trip it.

### 1.2 ToolSchema

```ts
type ToolSchema = {
  name: string                          // unique within AgentConfig.tools
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema draft-07 (opaque to kernel)
  requiresApproval: boolean             // if true, user_approve gate is applied
}
```

Kernel treats `inputSchema` as an opaque blob. Validation, if any, is host-side.

### 1.3 AgentConfig

Static per-session configuration. Never mutated.

```ts
type AgentConfig = {
  readonly tools: readonly ToolSchema[]
  readonly systemPrompt?: string        // used only by createInitialState()
  readonly contextLimit?: number        // user/session context window in tokens
  readonly softThreshold?: number       // default 0.75
  readonly hardThreshold?: number       // default 0.92
  readonly maxAgentDepth?: number       // host-side sub-agent nesting limit; default path is hard-capped to root -> child only
  readonly thinkingBudget?: number      // host adapter hint for extended thinking
}
```

**Rationale for separating config from state**: config is invariant across a session's event log. Keeping it out of the log keeps replay cheap and makes it trivial to "fork with different tools available." See [ADR 0004](../../architecture/adr/0004-config-state-separation.md).

### 1.4 AgentState

The single mutable(-across-events) unit. Every field is `readonly`; new state values are built by cloning.

```ts
type AgentStatus =
  | 'idle'                // waiting for user input
  | 'thinking'            // LLM call in flight
  | 'awaiting_approval'   // one or more tool calls need user approval
  | 'executing_tools'     // approved tool calls dispatched, waiting for results
  | 'done'                // agent finished the turn
  | 'error'               // fatal error; kernel does not auto-recover

type PendingToolCall = {
  callId: string
  name: string
  input: Record<string, unknown>
  status: 'awaiting_approval' | 'approved' | 'rejected' | 'dispatched'
}

type UsageTotal = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheCreationTokens: number
  readonly cacheReadTokens: number
}

type ApprovalMode = 'auto' | 'ask' | 'deny' | 'allow_all'

type AgentState = {
  readonly sessionId: string
  readonly messages: readonly Message[]
  readonly pendingCalls: readonly PendingToolCall[]
  readonly status: AgentStatus
  readonly usage: UsageTotal
  readonly cursor: number               // event counter; increments by exactly 1 per step()
  readonly approvalMode: ApprovalMode   // per-session gate for tools with requiresApproval
  readonly cwd?: string                 // session working directory (absolute); mutated by cwd_changed
  readonly error?: string
}
```

**Cursor semantics**: `cursor` is the count of `step()` calls that have been applied. After N `step()` invocations, `cursor === N`. This gives every point-in-time a canonical name for replay/fork addressing.

**Approval modes**:
- `auto` (default): tools with `requiresApproval: true` prompt the user; approved calls are dispatched.
- `ask`: every tool call prompts the user, even if the tool schema has `requiresApproval: false`.
- `deny`: the reducer synthesizes a failed `tool_result` (`ok: false`, content = "denied by approval policy") for every gated call, without emitting `request_approval`.
- `allow_all`: gated calls are dispatched immediately, as if they had `requiresApproval: false`. `AgentEvent` `user_approve` / `user_reject` never fire.

Approval mode is reducer-owned state, not host state; it is set by `approval_mode_changed` events and persisted in the JSONL log.

Context pressure is not reducer state. The host computes `ContextSnapshot` values from model-visible messages, tool schemas, reserve tokens, and context-window settings.

### 1.5 Events (kernel input)

```ts
type UsageDelta = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
}

type UserMessageEvent   = {
  kind: 'user_message'
  text?: string                          // convenience path for plain text
  content?: readonly MessageContent[]    // structured path (e.g. text + image blocks)
}
type LlmResponseEvent   = { kind: 'llm_response';   message: Message; usage?: UsageDelta }
type LlmErrorEvent      = { kind: 'llm_error';      error: string }
type UserApproveEvent   = { kind: 'user_approve';   callId: string }
type UserRejectEvent    = { kind: 'user_reject';    callId: string; reason?: string }
type ToolResultEvent    = { kind: 'tool_result';    callId: string; ok: boolean; content: string }
type CancelEvent        = { kind: 'cancel' }
type ClearEvent         = { kind: 'clear' }
type MessagesReplacedEvent = {
  kind: 'messages_replaced'
  reason: 'compaction' | 'manual_rewrite' | 'recovery'
  replaceRange: { start: number; end: number }
  replacementMessages: readonly Message[]
  artifactRef?: EventArtifactRef
}
type ApprovalModeChangedEvent = { kind: 'approval_mode_changed'; mode: ApprovalMode }
type CwdChangedEvent          = { kind: 'cwd_changed'; cwd: string }

type AgentEvent =
  | UserMessageEvent
  | LlmResponseEvent
  | LlmErrorEvent
  | UserApproveEvent
  | UserRejectEvent
  | ToolResultEvent
  | CancelEvent
  | ClearEvent
  | MessagesReplacedEvent
  | ApprovalModeChangedEvent
  | CwdChangedEvent
```

Events are the **only** input surface. Anything the host wants the kernel to know (a tool finished, the LLM answered, the user hit cancel) must be expressed as an event.

### 1.6 Effects (kernel output)

```ts
type CallLlmEffect         = { kind: 'call_llm';         messages: readonly Message[]; tools: readonly ToolSchema[] }
type CallToolEffect        = {
  kind: 'call_tool'
  callId: string
  name: string
  input: Record<string, unknown>
  cwd?: string                          // copied from state.cwd when the call is dispatched
}
type RequestApprovalEffect = { kind: 'request_approval'; callId: string; name: string; input: Record<string, unknown> }
type FinishEffect          = { kind: 'finish' }
type EmitErrorEffect       = { kind: 'emit_error';       error: string }

type Effect =
  | CallLlmEffect
  | CallToolEffect
  | RequestApprovalEffect
  | FinishEffect
  | EmitErrorEffect
```

Effects describe **what the host must do**. The kernel never performs IO. Every effect that produces a downstream state change comes back to the kernel as an event.

### 1.7 StepResult

```ts
type StepResult = {
  next: AgentState
  effects: readonly Effect[]
}
```

---

## 2. Kernel contract

### 2.1 Signature

```ts
function step(
  state: AgentState,
  event: AgentEvent,
  config: AgentConfig,
): StepResult
```

### 2.2 Contract

For all valid `(state, event, config)`:

1. **Pure**: `step(s, e, c)` returns the same `next` and `effects` every time. No IO. No `Date.now()`. No random. No `console.log`. No throw.
2. **Immutable input**: `state` is never mutated. `next` is a fresh object; nested arrays/objects are structurally shared only where they were not modified.
3. **Cursor monotonicity**: `next.cursor === state.cursor + 1`. Always. Even on no-op transitions.
4. **Effect list ordering is deterministic**: the effects array reflects the natural order (e.g. tool calls in the same LLM response are emitted in the order they appear in `message.content`).
5. **Effects are declarative**: they describe *what to do*, not *how*. Kernel does not embed host addresses, timeouts, or transport concerns.
6. **Config is read-only**: `step` never returns a modified config, and never mutates the passed-in config.

**A "no-op" transition** happens when an event arrives in a status where it has no legal effect (see §3). The kernel returns `{ next: {...state, cursor: state.cursor + 1}, effects: [] }`. This is intentional: it preserves the invariant that every event advances the cursor, so replay stays aligned even when the host feeds slightly out-of-order events.

### 2.3 Purity checklist for reviewers

- [ ] No `Math.random()`
- [ ] No `Date.now()` / `new Date()`
- [ ] No `console.*`
- [ ] No `process.*`
- [ ] No `fetch` / `require` / dynamic `import`
- [ ] No `throw` (kernel returns error via state, not exceptions)
- [ ] No mutation of arguments (verify with structural equality of input pre/post-call)

---

## 3. State machine

### 3.1 Statuses

```
              user_message
   ┌────────────────────────────┐
   │                            ▼
 idle ──────────────────────► thinking ──llm_error──► error
   ▲                           │  │
   │                           │  ├────── llm_response (plain text) ────► done
   │                           │  │
   │                           │  └────── llm_response (tool_calls) ─┐
   │                           │                                     │
   │                           │                                     ▼
   │                           │                     ┌─────────────────────────────┐
   │                           │                     │ any tool needs approval?    │
   │                           │                     └────────┬────────────────┬───┘
   │                           │                       yes ─►│              no │
   │                           │                             ▼                 ▼
   │                           │                     awaiting_approval    executing_tools
   │                           │                             │                 │
   │                           │        user_approve (last)  │  tool_result    │
   │                           │            ────────────────►│  (last pending) │
   │                           │                             ▼                 ▼
   │                           │            user_reject / tool_result          │
   │                           │            ─── all pending settled ──► thinking ◄─┘
   │                           │                             │
   └── user_message ── done ◄──┴─────── cancel ──────────────┘
```

### 3.2 Terminal statuses

- **`done`**: the turn has completed successfully. Kernel accepts a new `user_message` from here.
- **`error`**: unrecoverable within the kernel. Host may build a new state to retry; kernel itself does not exit `error`.

### 3.3 Legal (event, status) pairs

Any pair not listed below is a **no-op**.

| Event | Legal in status | Effect |
|---|---|---|
| `user_message` | `idle`, `done` | Append user msg → `thinking`, emit `call_llm` |
| `llm_response` (text only) | `thinking` | Append assistant msg → `done`, emit `finish` |
| `llm_response` (with tool calls) | `thinking` | Append assistant msg, populate pendingCalls, emit `request_approval` / `call_tool` per call (respecting `approvalMode`) |
| `llm_error` | `thinking` | → `error`, emit `emit_error` |
| `user_approve` | `awaiting_approval` | Flip that call to `dispatched`, emit `call_tool`; if no more awaiting → `executing_tools` |
| `user_reject` | `awaiting_approval` | Append synthetic `tool_result` (ok=false), remove from pending; if all settled → `thinking` + `call_llm`, else stay |
| `tool_result` | `executing_tools`, `awaiting_approval` | Append tool_result, remove from pending; if all settled → `thinking` + `call_llm`, else stay. |
| `cancel` | any except `done`/`error` | → `done`, drop pendingCalls, emit `finish` |
| `messages_replaced` | `idle`, `thinking`, `executing_tools`, `done`, `error` | Replace an explicit message range with supplied replacement messages; no effects |
| `approval_mode_changed` | any | Set `approvalMode = event.mode`; no effects |
| `cwd_changed` | `idle`, `done` | Set `cwd = event.cwd`; no effects |

---

## 4. Event handling — precise semantics

For each event, this section specifies:
- **Preconditions** (guards; failing → no-op)
- **State transition**
- **Effects emitted**

### 4.1 `user_message`

**Preconditions**
- `state.status ∈ { 'idle', 'done' }`
- Exactly one of `event.text` or `event.content` is present.

**Transition**
- Build a user message: `{ role: 'user', content: event.content ?? [{ type: 'text', text: event.text }] }`
- Append the message to `messages`
- `status → 'thinking'`
- Clear `error` (set to `undefined`)

**Effects**
- `[{ kind: 'call_llm', messages: next.messages, tools: config.tools }]`

### 4.2 `llm_response`

**Preconditions**
- `state.status === 'thinking'`
- `event.message.role === 'assistant'`

**Transition**
- Append `event.message` to `messages`
- If `event.usage` present: `usage → addUsage(state.usage, event.usage)` (see §4.2.1)
- Extract tool calls: `toolCalls = message.content.filter(c => c.type === 'tool_call')`

**Case A**: `toolCalls.length === 0`
- `status → 'done'`
- Effects: `[{ kind: 'finish' }]`

**Case B**: `toolCalls.length > 0`
- For each tool call, look up `requiresApproval` in `config.tools`. If tool name is unknown, treat `requiresApproval` as `true` (safe default).
- Apply `state.approvalMode`:
  - `auto`: gated calls (`requiresApproval: true`) start as `'awaiting_approval'`; ungated calls start as `'approved'`.
  - `ask`: every call starts as `'awaiting_approval'`.
  - `allow_all`: every call starts as `'approved'` regardless of `requiresApproval`.
  - `deny`: every gated call is settled inline — the reducer appends a synthetic `tool_result` (`ok: false`, content = "denied by approval policy") for that call and does NOT put it in `pendingCalls`. Ungated calls still start as `'approved'`.
- Emit one effect per pending call: `request_approval` for `'awaiting_approval'`, `call_tool` (with `cwd = state.cwd`) for `'approved'`.
- After emitting `call_tool` effects, flip those pending entries from `'approved'` to `'dispatched'`.
- If every gated call was denied and no `'approved'` / `'awaiting_approval'` entries remain: apply the pending-settled transition (§4.6.1) — typically `status → 'thinking'` with a fresh `call_llm`.
- Otherwise: `status → 'awaiting_approval'` if any entry is awaiting, else `'executing_tools'`.

#### 4.2.1 Usage accumulation

```ts
function addUsage(total: UsageTotal, delta: UsageDelta): UsageTotal {
  return {
    inputTokens: total.inputTokens + delta.inputTokens,
    outputTokens: total.outputTokens + delta.outputTokens,
    cacheCreationTokens: total.cacheCreationTokens + (delta.cacheCreationTokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (delta.cacheReadTokens ?? 0),
  }
}
```

### 4.3 `llm_error`

**Preconditions**
- `state.status === 'thinking'`

**Transition**
- `status → 'error'`
- `error → event.error`

**Effects**
- `[{ kind: 'emit_error', error: event.error }]`

### 4.4 `user_approve`

**Preconditions**
- `state.status === 'awaiting_approval'`
- A pending call with `callId === event.callId` exists AND its status is `'awaiting_approval'`

**Transition**
- Flip that pending call's status to `'dispatched'`
- If any remaining pending call is still `'awaiting_approval'`: `status → 'awaiting_approval'` (stay)
- Otherwise: `status → 'executing_tools'`

**Effects**
- `[{ kind: 'call_tool', callId, name, input }]` for the approved call

### 4.5 `user_reject`

**Preconditions**
- `state.status === 'awaiting_approval'`
- A pending call with `callId === event.callId` exists AND its status is `'awaiting_approval'`

**Transition**
- Append a synthetic tool_result message:
  ```ts
  {
    role: 'tool',
    content: [{
      type: 'tool_result',
      callId,
      ok: false,
      content: event.reason ?? 'User rejected this tool call.',
    }],
  }
  ```
- Remove the call from `pendingCalls`.
- Then apply the "pending settled" transition (§4.6.1).

### 4.6 `tool_result`

**Preconditions**
- `state.status ∈ { 'executing_tools', 'awaiting_approval' }`
  - `awaiting_approval` is included because parallel tool calls may resolve while others still await approval.
- A pending call with `callId === event.callId` exists AND its status is `'dispatched'`

**Transition**
- Append tool_result message with `{ callId, ok, content }` from the event.
- Remove the call from `pendingCalls`.
- **`memory` special case (scope='session' only)**: if the settled call's `name === 'memory'`, `event.ok === true`, `input.scope === 'session'`, and `input.operation === 'write'`, upsert `{ key: input.key, content: input.content, updatedAt: input.updatedAt }` into `state.memory` (replacing any entry with the same key). Symmetric for `input.operation === 'delete'` — remove the matching entry. Workspace / global scope produce ordinary tool_results and never touch `state.memory`. This is the only tool the reducer looks inside; every other tool result is opaque.
- Apply pending-settled transition (§4.6.1).

#### 4.6.1 Pending-settled transition

After removing a settled call, examine remaining `pendingCalls`:

- **If non-empty**: some tool calls are still in flight or awaiting approval. Stay. `status → 'awaiting_approval'` if any is awaiting, else `'executing_tools'`. No effects.
- **If empty**: all tool calls have resolved. Go back to LLM. `status → 'thinking'`. Effects: `[{ kind: 'call_llm', messages: next.messages, tools: config.tools }]`.

### 4.7 `cancel`

**Preconditions**
- `state.status !∈ { 'done', 'error' }`

**Transition**
- `status → 'done'`
- `pendingCalls → []` (dropped; host is responsible for cleaning up in-flight tool executions)

**Effects**
- `[{ kind: 'finish' }]`

### 4.8 `messages_replaced`

**Preconditions**
- `replaceRange.start` and `replaceRange.end` are valid message indexes.
- `replaceRange.start <= replaceRange.end`.
- The replacement must not orphan pending tool calls. If the current state has pending calls, the replaced range must not remove the assistant `tool_call` message that introduced those calls while leaving the pending calls active.

**Transition**
- Invalid replacements are no-ops except for cursor advancement.
- Valid replacements set:
  `messages = messages.slice(0, start) + replacementMessages + messages.slice(end)`.
- `usage`, `pendingCalls`, and `status` are unchanged.
- `reason` and `artifactRef` are replay-visible facts but do not affect reducer logic.

**Effects**
- `[]`

### 4.9 `approval_mode_changed`

**Preconditions**
- None. Approval mode is a session-level control the user can flip at any time.

**Transition**
- `approvalMode → event.mode`.
- Existing `pendingCalls` are NOT retroactively re-evaluated. A call that was already in `'awaiting_approval'` stays there until an explicit `user_approve` / `user_reject` arrives. Changing to `'deny'` while calls are pending does not synthesize rejections for them — the mode only affects future dispatches.

**Effects**
- `[]`

### 4.10 `cwd_changed`

**Preconditions**
- State status is `idle` or `done`; other statuses ignore this event as an illegal transition. `event.cwd` MUST be an absolute path — validation against the workspace sandbox is host-side. Host-side `client:set_cwd` handlers must reject non-resting sessions before dispatch so users do not see a successful UI action that the reducer will ignore.

**Transition**
- `cwd → event.cwd`.

**Effects**
- `[]`

---

## 5. Invariants

Any deviation from these is a bug.

### I1: Cursor monotonicity
Every `step` call increments `cursor` by exactly 1, regardless of whether the event was legal.

### I2: Purity
`step(s, e, c)` returns equal (deep-equal) results for equal inputs. `s` is never mutated.

### I3: Message log is append-only within a state
`step` may append to `messages`, but never removes or edits prior entries. (Fork throws away suffixes at a different level — see §6.)

### I4: PendingCalls consistency
- Every `PendingToolCall.callId` in `state.pendingCalls` corresponds to a `ToolCallContent` in some assistant `Message` earlier in `state.messages`.
- Every settled tool call (`tool_result` message present in `messages`) is absent from `pendingCalls`.

### I5: Status ↔ pendingCalls invariant
- `status === 'idle' | 'thinking' | 'done' | 'error'` → `pendingCalls.length === 0` (except transiently during a step)
- `status === 'awaiting_approval'` → at least one pending call has `status: 'awaiting_approval'`
- `status === 'executing_tools'` → all pending calls have `status: 'dispatched'`

### I6: Effects deterministic order
For any given `(state, event, config)`, the effects list is emitted in a deterministic, spec-defined order (tool calls in message-content order).

### I7: Terminal status is sticky per turn
Once `status` reaches `'done'` or `'error'`, only `user_message` (from `done`) can re-enter the loop. `error` is terminal until an external replacement of state.

### I8: Reject synthesizes a tool_result
A `user_reject` event results in exactly one appended `tool_result` message with `ok: false`, so the LLM always sees a symmetrical `tool_call ↔ tool_result` pairing in the transcript.

---

## 6. Fold and Fork

### 6.1 `fold`

```ts
function fold(
  initial: AgentState,
  events: readonly AgentEvent[],
  config: AgentConfig,
): AgentState
```

**Contract**: `fold(s0, [e1, e2, ..., eN], c)` returns `step(step(step(s0, e1, c).next, e2, c).next, ...).next` after N steps. Effects are discarded (host already performed them the first time).

**Property**: Because `step` is pure, `fold` is deterministic. Given the same `(initial, events, config)`, `fold` always returns the same final state.

### 6.2 `foldWithTrace`

```ts
function foldWithTrace(
  initial: AgentState,
  events: readonly AgentEvent[],
  config: AgentConfig,
): {
  final: AgentState
  trace: {
    cursor: number         // = state after applying this event
    event: AgentEvent
    state: AgentState
    effects: readonly Effect[]
  }[]
}
```

For each event, records the resulting state and emitted effects. Used by the dashboard for the event timeline and scrubber.

### 6.3 `fork`

```ts
function fork(
  initial: AgentState,
  originalEvents: readonly AgentEvent[],
  cursor: number,
  newEvents: readonly AgentEvent[],
  config: AgentConfig,
): AgentState
```

**Semantics**: Replay `originalEvents[0..cursor)` from `initial` (keeping the prefix), then continue with `newEvents`. The suffix `originalEvents[cursor..]` is discarded in the forked branch. The original event log is not mutated (fork is a pure computation).

**Boundary cases**:
- `cursor === 0`: fork from the very beginning; `newEvents` fully replace the log.
- `cursor === originalEvents.length`: fork "at the end" is equivalent to `fold(initial, [...originalEvents, ...newEvents], config)`.
- `cursor > originalEvents.length`: implementations MAY treat this as `cursor === originalEvents.length` (permissive) or reject (strict). Reference implementation is permissive (via `slice`).

### 6.4 Why fold/fork are 3-4 lines each

Because `step` is pure and total (no throws), fold is just a reduce and fork is a slice + reduce. This isn't a coincidence — it's the whole reason we chose the pure-function-FSM architecture. See [ADR 0001](../../architecture/adr/0001-pure-reducer.md).

---

## 7. What the kernel deliberately does NOT do

These are all valid concerns for an agent system, but the kernel does not handle them. Host is responsible.

| Concern | Why not in kernel | Where it belongs |
|---|---|---|
| LLM API calls | Would require IO | Host: `core/llm/*` adapter |
| Tool execution | Would require IO | Executor process |
| Approval UI | Would require IO / async | Dashboard, via `request_approval` effect |
| Rate limiting / retry | Would introduce time | Host, wrapping LLM adapter |
| Context compaction (auto-shrinking messages) | Would introduce heuristics + IO | Host, as a pre-`call_llm` step |
| Planning / TodoWrite | Kernel doesn't know about tasks | External tool; dashboard may derive task display from ordinary tool calls |
| Memory / CLAUDE.md loading | Would require FS | Host, pre-inject into `systemPrompt` |
| Subagent spawning | Kernel doesn't recurse | Host, orchestrate multiple sessions |
| Token / context policy beyond accumulation | Just accumulates usage deltas and context pressure | Host / Dashboard decide prompts, alerts, and compaction policy |
| Cancellation of in-flight tools | Only handles state | Host cancels IO |
| Session persistence | Would require IO | Host writes JSONL event log |
| Streaming partial LLM tokens | Complicates purity | Host may buffer and emit one `llm_response` |
| Tool schema validation | Opaque JSON Schema | Host validates before dispatch |
| Auth / secrets | Not kernel's job | Host wires providers |

**Rule of thumb**: if it involves *when* (timing), *where* (IO), or *how much* (heuristics/thresholds), it does not belong in the kernel.

---

## 8. Reference implementation

- Source: `packages/kernel/src/`
- Tests: `packages/kernel/src/core.test.ts` — tests covering transitions, purity, fold, fork, compaction, approval modes, cwd, memory, ordinary tool results, and image content preservation.

The reference implementation is the tie-breaker only for things this spec is silent about. Where they conflict, spec wins and the ref impl should be patched.

---

## 9. Versioning

This spec is v0.1. Breaking changes bump the major version. The event/effect/state shapes are considered public API and any change is a breaking change. Adding a new event or effect *kind* to the union is allowed as a minor bump if it does not change existing behavior.
