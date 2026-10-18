# ADR 0011: Rename `packages/core` → `packages/host`, `reducer.ts` → `core.ts`

**Status**: accepted
**Date**: 2026-07-04

## Context

Two names in the v0.1 layout are misleading:

**Name 1: `packages/core/`** — the package that hosts the kernel, runs the LLM adapter, owns the Socket.IO server, and writes the JSONL log.

Calling this package "core" implies it *is* the core of the project. It isn't — the core of the project is the pure-function reducer in `packages/kernel/`. What `packages/core/` actually is: the runtime environment that turns the kernel into a service. The word for that concept, in the rest of our docs, is "**host**". SPEC.md, ADR 0001, ADR 0005, ARCHITECTURE.md, and the implementation guide all use "host" prose (e.g., "the host consumes effects", "IO is the host's job"). The package name doesn't match the term of art we already use.

**Name 2: `packages/kernel/src/reducer.ts`** — the file containing the actual FSM.

"Reducer" is Redux terminology. It emphasizes the state-folding aspect but understates the file's role: this file *is* the agent's behavior definition. Every legal state transition and every effect emission lives here. Calling it `reducer.ts` puts the most important file in the project at a name-level equal footing with utility files (`state.ts`, `fold.ts`).

## Decision

Two renames:

1. **`packages/core/` → `packages/host/`**, npm name `@agent-kernel/core` → `@agent-kernel/host`.
2. **`packages/kernel/src/reducer.ts` → `packages/kernel/src/core.ts`** (with test file renamed accordingly).

After the renames, the three concepts have distinct, unambiguous names:

| Concept | Name |
|---|---|
| The whole package containing the pure function + types + combinators | **`packages/kernel/`** |
| The FSM heart file inside that package (~300 lines) | **`packages/kernel/src/core.ts`** |
| The runtime service that hosts the kernel + LLM adapter + Socket.IO | **`packages/host/`** |

## Alternatives considered

**Keep the v0.1 names.**

*Rejected.* The mismatch between "the package is called core" and "the docs consistently say host" is a real cognitive tax on every new reader. Fixing it early — before host / executor / dashboard code all reference the old name — was nearly free; fixing it later would have been a wide refactor.

**Rename `packages/core/` to `packages/engine/`.**

*Rejected.* Considered as an alternative to `host`. "Engine" reads as "the thing that drives everything" (V8 engine, game engine) — which is closer to how one might describe the kernel, not the runtime that hosts the kernel. It also collides with product names in the AI agent space (Google's "Agent Engine", various framework "agent engines") that mean the whole system, not the host runtime. `host` is the unambiguous, spec-aligned choice.

**Rename `reducer.ts` to `machine.ts`, `transition.ts`, or `agent.ts`.**

*Rejected in favor of `core.ts`* for three reasons:
- **`machine.ts`** would be accurate ("this is the state machine") but generic; grep results for "machine" across a large codebase are noisy.
- **`transition.ts`** describes what the file *does*, not what it *is*. The file is the FSM itself, not just the transition function.
- **`agent.ts`** is tempting (the project is agent-kernel) but reads as "the agent implementation" — misleading, since the actual agent behavior emerges from kernel + host + tools together, not from any one file.
- **`core.ts`** correctly labels this file as the core of the kernel, the innermost point of the whole project. That's the truth we want the name to tell.

**Rename `packages/kernel/` itself** (e.g., to `packages/agent-core/`).

*Rejected.* The npm package name `@agent-kernel/kernel` is already published in the design docs, referenced across every doc, and gives the project its identity. Cost of the rename is high; benefit is small (the current name is already accurate).

## Consequences

**Good**:
- Package names match the vocabulary the docs already use ("host loop", "host owns IO"). New readers no longer have to translate "core the package" ↔ "host the concept".
- The file name `core.ts` matches the project's own claim that "the reducer is the core of this project."
- The three-word vocabulary (**kernel** / **core** / **host**) becomes unambiguous, with each word pointing at exactly one thing.

**Bad**:
- One-time doc-and-code sweep to update every reference to `packages/core/` / `@agent-kernel/core` / `reducer.ts` / `reducer.test.ts`.
- External references (if any exist yet — currently only internal docs) need updating. Cost was bounded because the rename happened before host implementation began.
- Git history for the two renamed files will require `git log --follow` to trace back through the rename. Acceptable.

## Verification

- `find packages -type d -name core` returns nothing under `packages/`.
- `packages/host/package.json` declares `"name": "@agent-kernel/host"`.
- `packages/kernel/src/core.ts` exists; `packages/kernel/src/reducer.ts` does not.
- `grep -r "packages/core\|@agent-kernel/core\|reducer\.ts\|reducer\.test\.ts" docs README.md` returns nothing.
