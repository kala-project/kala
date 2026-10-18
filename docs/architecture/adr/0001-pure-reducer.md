# ADR 0001: Kernel as a pure-function reducer

**Status**: accepted
**Date**: 2026-07-04

## Context

An agent kernel needs to (a) decide when to call the LLM, (b) decide when to dispatch tools, (c) handle approval gates, (d) sequence parallel tool calls, and (e) know when a turn is done. Existing implementations do this in wildly different shapes:

- **pi** (~3.2K LOC): class-based, mutable state, subscriber pattern
- **opencode**: Effect-monad functional
- **codex**: async generator over a Rust binary
- **clawspring**: imperative Python generator with a `while True` loop

Two properties we want that these don't uniformly provide:
- **Replay**: given an event log, reconstruct any historical state deterministically
- **Fork**: at any cursor, take a different path

A third property we care about but it's negotiable:
- **Readability** — the kernel is the pedagogical artifact of the project

## Decision

**The kernel is a pure function `step(state, event, config) → { next, effects }`.**

- All state is a plain immutable data structure (`AgentState`).
- All inputs are events (`AgentEvent` union).
- All outputs are (a) the next state and (b) a list of declarative effects (`Effect` union).
- The kernel does zero IO: no `fetch`, no `fs`, no `Date.now()`, no `Math.random()`, no `throw`.
- Everything time-dependent, network-dependent, or filesystem-dependent lives in the host (Core) as an effect handler.

This is the Elm / Redux architecture, adapted to agent loops.

## Alternatives considered

**Class with mutable state (pi's approach).** Rejected because replay/fork become non-trivial: you have to serialize the class, which drags in method identity and internal caches. Testing purity is impossible.

**Effect monad (opencode's approach).** Rejected because it imposes a heavy conceptual load on newcomers. Effect is a great library, but reading it requires knowing effect systems. This project's #1 property is "readable by anyone who knows JavaScript."

**Async generator (codex / clawspring).** Rejected because generators are inherently stateful across `yield` points. You cannot mid-generator save/restore. Fork is impossible without hand-lifting the state.

**State machine library (XState).** Considered, and it's conceptually close. Rejected because XState pulls in a ~30KB runtime and its schema layer overlaps our own `AgentState`. Adopting it would make the "kernel is 350 lines" claim depend on someone else's library size.

## Consequences

**Good**:
- Replay is `events.reduce(step, initial)`. Fork is a slice + reduce. Both are 3 lines.
- 100% unit test coverage is cheap because there is no IO to mock.
- The kernel package has zero runtime dependencies.
- We can port the kernel to any language that has sum types (Rust, TypeScript, F#, OCaml) as literally the same code shape.

**Bad**:
- Every effect the kernel wants to trigger requires a corresponding event to come back. This forces the host to be explicit about tool timeouts, LLM errors, etc. — good for correctness, but more upfront wiring.
- The host loop is a small amount of ceremony ("call step, drain effects, feed responses back"). We think this is a fair price and it lives in Core, not in kernel.
- Streaming partial LLM tokens is awkward — one turn = one `llm_response` event by default. Providers that stream must be buffered by the LLM adapter, or the kernel needs a `llm_delta` event kind (v2).

## Verification

Every property is testable and tested in `packages/kernel/src/core.test.ts`:
- `step` never mutates input state
- Same input yields same output (idempotency)
- Fold replays a log deterministically
- Fork at cursor N replaces the suffix

If these tests fail, the whole design is compromised. That's exactly what makes them worth having.
