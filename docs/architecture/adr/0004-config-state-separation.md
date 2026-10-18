# ADR 0004: Separate `AgentConfig` from `AgentState`

**Status**: accepted
**Date**: 2026-07-04

## Context

The kernel needs to know two categories of things:

1. **Session-invariant**: what tools are available, what the system prompt says, which model to nominally use.
2. **Session-evolving**: current messages, pending tool calls, cursor, status, usage totals.

The initial v0.1 sketch put both in one `AgentState`. Then we observed:

- Every event log entry included `tools` (because `tools` was in state, and state was serialized).
- Every replay carried `tools` through every fold step, when it never changed.
- Forking with a different set of tools required tearing apart state.

## Decision

**Split into two types**:

- `AgentConfig` — `{ tools, systemPrompt }`, immutable per session, passed as a **third argument** to `step(state, event, config)`.
- `AgentState` — the mutable part, evolves per event.

The event log stores `config` **once**, in the header. Only `state` changes evolve through events.

## Alternatives considered

**Keep everything in `AgentState`.** Rejected — see above. Bloats every log line and every fold call.

**Pass `config` as a currying step: `withConfig(config)(state, event) → ...`.** Considered, ergonomic in a language like OCaml or Haskell. In TypeScript it's mostly cosmetic vs. the third parameter. Rejected for clarity.

**Store config in a closure captured by a per-session `step` instance.** Rejected — that turns `step` into a factory, breaking the "pure function you can call directly" property. Testing becomes awkward.

**Global config module.** Rejected — this ties the kernel to a runtime concept of a "current session," which we specifically avoid.

## Consequences

**Good**:
- Event log lines are ~50 bytes smaller each (no tools array).
- `fork(events, cursor, newEvents, config)` can take a **different** config from the original session — you can literally fork with a new tool set. This is a first-class feature, not a hack.
- The type separation makes it obvious to a reader that `tools` never changes mid-session (it's in `AgentConfig`, not in `AgentState`). If a future feature *does* need mid-session tool changes, it will be a visible, discussed API change, not a stealthy mutation.

**Bad**:
- Adds a parameter to every `step` call. `step(state, event, config)` vs. `step(state, event)`. Slight verbosity cost.
- `fold` / `foldWithTrace` / `fork` all now take config, propagating the parameter. Same cost.
- Existing consumers (if any) had to update their signatures during the v0.1 refactor. One-time cost; done.

## Verification

- Types: `packages/kernel/src/types.ts` defines `AgentConfig` and `AgentState` distinctly.
- Tests: `packages/kernel/src/core.test.ts` uses a `CONFIG` fixture via `createConfig({ tools: TOOLS })` and passes it as the third argument to every `step`/`fold`/`fork` call.
- Event log spec: `docs/protocol/event-log.md` §2.1 encodes `config` in the header only.

The mental model: "**Config is what you set once. State is what evolves.**"
