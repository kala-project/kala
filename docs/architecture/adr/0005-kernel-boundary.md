# ADR 0005: Planning, memory, and subagents live outside the kernel

**Status**: accepted
**Date**: 2026-07-04

## Context

Real-world coding agents typically ship with:

- **Planning**: TodoWrite / TodoRead tools (Claude Code), task decomposition, subtask tracking
- **Long-term memory**: CLAUDE.md-style context files auto-loaded per project, "remember X" across sessions
- **Subagents**: the ability for a main agent to spawn child agents for delegated work (research, refactor, subtasks)

We could bake these into the kernel:
- A `TaskState` embedded in `AgentState`
- A `MemoryLoad` effect on session start
- A recursive `spawn_subagent` effect

**pi** does exactly this (compaction, retry, thinking-level switching are all in-loop). **Claude Code** does too. The kernel gets large fast.

## Decision

**None of these features live in the kernel.**

- **Planning** is a *tool* (or a set of tools). If the user wants TodoWrite, they add it to `AgentConfig.tools`. The tool's implementation is in Executor. Its state persistence — if any — is Executor's problem.
- **Memory** is *pre-injection into the system prompt*. Host loads project context (CLAUDE.md, etc.) as a Host-side step **before** creating the session. Once the session starts, memory is just part of `AgentState.messages[0]`.
- **Subagents** are *host-orchestrated*. If a tool call is a "spawn subagent," it's the host's job to create a new session, drive it to completion, and stringify the result. The main kernel sees only a single tool call and a single tool result.

The kernel is intentionally ignorant of task lists, files on disk, and other sessions.

## Alternatives considered

**Bake planning into the kernel** (à la Claude Code).

*Rejected* for three reasons:
1. Kernel bloat. A generic planning subsystem is ~500 LOC of state and transitions on its own; that doubles the kernel.
2. Opinion lock-in. Planning heuristics differ per use case (research task vs. code refactor); baking one in makes the kernel less general.
3. Undermines "readable in one afternoon" positioning. If the kernel is small, `agent-kernel` has a clear pedagogical role. If it's medium-sized, so are its competitors.

**Bake memory into the kernel.**

*Rejected*. Memory is fundamentally an IO operation: read files, dedupe context, budget tokens. All three of those are host concerns per [ADR 0001](0001-pure-reducer.md). If the kernel needed memory, it would need FS access, and it wouldn't be pure.

**Bake subagents via recursion.**

*Rejected*. Recursion inside a pure reducer isn't impossible — you could model it as "yield a `spawn_subagent` effect, wait for a `subagent_done` event." But now the kernel needs to track subagent depth, propagate `sessionId`s, and reason about parent/child state. All of that is orchestration, which the host does better.

## Consequences

**Good**:
- Kernel stays ~350 LOC.
- We can iterate on planning strategies, memory schemas, subagent orchestration as separate packages *without changing the kernel*. This is the "internal API stable, external evolves" property.
- Users can plug in their own planning tool. There's no built-in `TodoWrite` for us to argue about the semantics of.
- Testing is trivial: the kernel doesn't care about task lists, so tests never mock task state.

**Bad**:
- Out of the box, `agent-kernel` doesn't include a task list. Users who expect one will be surprised. Mitigation: ship an example package that adds TodoWrite as a tool, so the recipe is visible.
- The host layer is doing more work. Subagent orchestration in Host is not trivial. Mitigation: keep it out of v1 entirely, add in v2 as an explicit feature.
- Some agent behaviors that seem "part of the kernel" (auto-compact, retry on rate limit) look surprising when they live in the host. Documentation must be explicit about the boundary.

## Verification

The kernel spec (`docs/reference/kernel/spec.md` §7) enumerates what the kernel deliberately does NOT do. Any pull request that tries to add planning / memory / subagent logic to the kernel should be rejected on the grounds of this ADR.

The mental model: **the kernel is a state machine. Everything else is the host's job.**
