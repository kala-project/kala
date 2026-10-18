# ADR 0010: FSM as a hand-rolled dispatch table, not XState

**Status**: accepted
**Date**: 2026-07-04

## Context

The kernel's `step(state, event, config)` function is, formally, a finite state machine: six statuses (`idle`, `thinking`, `awaiting_approval`, `executing_tools`, `done`, `error`) × the `AgentEvent['kind']` union, with a defined transition per legal `(status, event)` pair and no-op behavior everywhere else (see [`docs/reference/kernel/spec.md`](../../reference/kernel/spec.md) §3).

The v0.1 implementation expressed this as one big `switch (event.kind)` block with per-branch `if (state.status !== expected) return noop(state)` guards. That works, but it doesn't structurally mirror the legality table in SPEC — a reader has to trace the branches to reconstruct the FSM shape.

Two options for improving this:

1. **Adopt XState [1]** — the widely-used JS statechart library. Get visualization, devtools, formal machine semantics, ecosystem recognition.
2. **Hand-roll a two-dimensional dispatch table** — `Record<Status, Partial<Record<EventKind, Handler>>>`. Fallthroughs are automatic no-ops. Zero dependencies.

## Decision

**Hand-rolled dispatch table.** The reducer becomes:

```typescript
const transitions: Record<Status, Partial<Record<AgentEvent['kind'], Handler>>> = {
  idle: {
    user_message: (s, e, c) => { /* ... */ },
    cancel: (s, e, c) => noop(s),
  },
  thinking: {
    llm_response: (s, e, c) => { /* ... */ },
    llm_error: (s, e, c) => { /* ... */ },
    cancel: (s, e, c) => { /* ... */ },
  },
  // ...
}

export function step(state, event, config): StepResult {
  const handler = transitions[state.status]?.[event.kind]
  return handler ? handler(state, event, config) : noopAdvance(state)
}
```

The `transitions` object **is** SPEC §3's legality table, expressed as code. Illegal pairs are "absent from the table"; the fall-through path is a single no-op that advances the cursor and leaves state otherwise unchanged.

## Alternatives considered

**Adopt XState (v5).**

*Rejected.* The reasons compound:

1. **Violates [ADR 0001](0001-pure-reducer.md).** The kernel is zero-runtime-dependency by hard rule. That property is what lets a reader open `packages/kernel/src/` and read the whole thing in an afternoon. Adding `xstate` (~30 KB minified, plus its own mental model of actors / interpreters / spawn / send / raise) trades away exactly the property this project is built around.
2. **Concept mismatch.** XState v5 pushes an actor model — machines "run" and communicate via `send`/`spawn`. Our kernel is a pure function that never "runs"; the host calls it once per event. XState's `actions` are callbacks; our `effects` are data the host consumes. Bridging these idioms produces awkward code, not idiomatic XState.
3. **We use none of XState's power features.** Hierarchical states, parallel regions, `after` timers, `invoke` sub-services — the kernel is a flat 7-state machine with no timers and no children. XState is F1-grade for a shopping trip.
4. **Portability tax.** If someone ever ports the kernel to Rust or Go (see [ROADMAP.md](../../roadmap.md) Post-v1), "translate a pure function" is a weekend; "translate XState's statechart semantics" is a project.

**Keep the flat `switch (event.kind)` with inline status guards.**

*Rejected.* Works, but doesn't mirror the SPEC table structurally. A reader can't glance at the code and see "these are the seven legal pairs from idle" — they have to scan every case for its `if (state.status !== ...)` guard. Structural mirroring is a documentation asset we're paying for cheaply with the dispatch table.

**A generic FSM library that's smaller than XState** (e.g., `@xstate/fsm`, `robot3`).

*Rejected.* Same violation of ADR 0001 for smaller savings. If we're going to take the dependency, XState's ecosystem is the payoff; `@xstate/fsm` gives up the ecosystem without recovering zero-dep. Worst of both.

## Consequences

**Good**:
- Zero runtime deps preserved.
- The `transitions` object *is* the SPEC table. A reader can point at row `thinking` and column `llm_response` and see the exact code that runs. Non-obvious spec bugs become obvious.
- No-op behavior for illegal pairs is a single path (`handler ?? noopAdvance`), not seven scattered guards.
- Adding a new status or event kind is a **local** change: add a row / column and its handlers. No `switch` growth.
- Testing story unchanged — the public API (`step`) is exactly the same, so the 23 existing tests migrate as-is.

**Bad**:
- No free visualization. If we want a state diagram, we draw it (or auto-generate one from the `transitions` object, which is easy — it's data).
- No devtools. In practice, the JSONL event log + fold combinator already gives us "step-by-step time-travel debugging", which is what devtools would provide.
- We give up "used XState" as an ecosystem-familiarity signal. Trade: a hand-rolled FSM that mirrors the spec 1:1 stays legible without pulling in a runtime.

## Verification

- `packages/kernel/src/core.ts` (post-rename from `reducer.ts`) defines a `transitions` object of type `Record<Status, Partial<Record<AgentEvent['kind'], Handler>>>`.
- `packages/kernel/package.json` `dependencies` is `{}`. `devDependencies` may include only types and test tools.
- All 23 tests in `core.test.ts` continue to pass unmodified — public signature is preserved.

## References

[1] https://stately.ai/docs/xstate
