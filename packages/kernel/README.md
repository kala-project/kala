# @agent-kernel/kernel

The pure-function heart of `agent-kernel`. An FSM, some types, and two combinators — nothing else. Zero runtime dependencies.

---

## What this package is

```typescript
step(state: AgentState, event: AgentEvent, config: AgentConfig): StepResult
```

That's it. Given the current state, an event, and the immutable session config, return the next state and any side effects the host should perform (call the LLM, run a tool, persist, emit progress, finish).

If you know Redux or Elm, you already have the mental model. The difference is that here the reducer *also* yields effects, so the host can perform them and feed the results back as events. Internally, `step` is a two-dimensional dispatch table indexed by `(status, event.kind)` — a finite state machine that mirrors [SPEC §3](../../docs/reference/kernel/spec.md) row-for-row. See [ADR 0010](../../docs/architecture/adr/0010-fsm-dispatch-table.md).

## Public API

```typescript
import {
  // types
  Message, MessageContent, TextContent, ToolCallContent, ToolResultContent,
  ToolSchema, ToolResult,
  AgentConfig, AgentState, AgentEvent, Effect,
  StepResult, TraceEntry,
  UsageTotal, UsageDelta,

  // FSM step
  step,

  // factories
  createInitialState, createConfig,

  // combinators
  fold, foldWithTrace, fork,
} from '@agent-kernel/kernel'
```

See [`docs/reference/kernel/spec.md`](../../docs/reference/kernel/spec.md) for the normative contract and [`docs/architecture/adr/0001-pure-reducer.md`](../../docs/architecture/adr/0001-pure-reducer.md) for why it's shaped this way.

## Non-goals

The kernel deliberately does **not**:
- Call any LLM
- Execute any tool
- Read or write any file
- Open any socket
- Manage timers, retries, or rate limits
- Track subagents or task lists

All of that is the host's job. See [ADR 0005](../../docs/architecture/adr/0005-kernel-boundary.md).

## Running tests

```bash
pnpm test
pnpm typecheck
pnpm build
```

## Invariants

Every invariant is enumerated in [`docs/reference/kernel/spec.md`](../../docs/reference/kernel/spec.md) §5 and covered by a test:

- I1: cursor is monotonic
- I2: `step` is pure (deep-equal input state before/after)
- I3: `state.messages` is append-only
- I4: `pendingCalls` consistent with pending tool calls
- I5: `status` ↔ `pendingCalls` invariant
- I6: effects in deterministic order per event
- I7: terminal statuses (`done`, `error`, `cancelled`) are sticky
- I8: rejecting a tool call synthesizes a `tool_result` event

If you're modifying the kernel, `pnpm test` must remain green *and* an invariant test must exist for every change to state shape.

## File layout

```
src/
├── types.ts     # all types
├── core.ts      # step() — the FSM dispatch table
├── state.ts     # createInitialState, createConfig
├── fold.ts      # fold, foldWithTrace, fork
├── index.ts     # barrel
└── core.test.ts # covers every legal transition
```
