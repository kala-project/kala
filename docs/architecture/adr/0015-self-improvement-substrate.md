# ADR 0015: A substrate for self-improving meta-agents

Status: accepted
Date: 2026-07-11

## Context

`agent-kernel` is an open-source coding-agent reference implementation: a pure
FSM kernel, an event-sourced host, a sandboxed executor. Its priority-1 promise
is *readability* — small enough to read in an afternoon.

We want it to also serve as a **substrate**: a base platform on which a
*meta-agent* — an agent that improves an agent — can run a real
**auto-evolve** loop. The meta-agent inspects how a coding agent performed on a
task, proposes a change to that agent's *harness*, re-runs, and keeps the change
only if an independent judge says it got better. This is the "harness
engineering for self-improvement" idea (Weng, 2026) expressed in our codebase.

The tension: a self-improvement platform naturally wants to grow (evaluators,
variant management, optimization loops), and that growth spends the
readability budget. Left unconstrained it would turn a pedagogical kernel into
yet another sprawling framework — exactly what [ADR 0005](0005-kernel-boundary.md)
guards against.

Three questions decide the shape, and were settled deliberately:

1. **What may the meta-agent change?** The *harness surface*: system prompt,
   tool set, and the optional extension knobs. **Not** the kernel FSM and
   **not** the wire protocol. Those are the stable substrate the experiment
   runs *on*, not the thing under optimization this round.

2. **Who judges "better", and can the meta-agent cheat it?** An **evaluator
   that lives outside the meta-agent's reach**. It reads the finished session's
   JSONL log and returns a score. The meta-agent can trigger a run and read the
   result, but it cannot read or edit the evaluator's code — otherwise
   "improvement" collapses into reward hacking.

3. **How hard is the readability line?** **Hard.** The core kernel and the
   existing host driver do not change by a single line for this feature. Every
   platform capability is a new, optional, bolted-on layer.

## Decision

**Add a new package `@agent-kernel/substrate` that sits entirely above the host's
public API. It contains a harness spec, a task runner, an out-of-loop
evaluator, a meta-agent proposer, and an evolve orchestrator. The kernel and the
existing host core are untouched; the substrate depends only on
`@agent-kernel/host`'s published exports and reads the JSONL event log — an
interface that already exists.**

The layering — nothing below the line moves:

```
┌──────────────────────────────────────────────────────────────┐
│  meta-agent loop  (substrate/meta-agent.ts)                    │
│  read trajectory + eval breakdown → propose a HarnessMutation  │
└───────────┬───────────────────────────────────┬──────────────┘
            │ may mutate ONLY                     │ may only REQUEST a run,
            ▼ (prompt / tools / extensions)       ▼ never read evaluator code
   ┌────────────────────┐            ┌──────────────────────────┐
   │ Harness (spec)     │            │  Evaluator (out of loop)  │
   │ applyMutation()    │            │  reads JSONL log → score  │
   └─────────┬──────────┘            └────────────┬─────────────┘
             │ compiled into AgentConfig          │ reads the log of
             ▼                                    ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Runner (substrate/runner.ts) → runHostLoop(...)          │
   │  ────────────────────────────────────────────────────────│
   │  ★ kernel + host + executor: UNCHANGED ★                  │
   │  pure FSM · JSONL event log · sandbox / approval / hooks  │
   └──────────────────────────────────────────────────────────┘
```

### The programmable surface: `Harness`

A `Harness` is plain, serializable data — the subset of an agent's setup a
meta-agent is allowed to touch:

- `systemPrompt: string`
- `tools: ToolSchema[]` (which tools are offered, and their descriptions)
- `extensions: { … }` (bounded knobs: e.g. compaction thresholds, hook policy)

A `HarnessMutation` is a small, typed, reviewable delta (`set_system_prompt`,
`add_tool_hint`, `drop_tool`, `set_extension_knob`, …). `applyMutation(harness,
mutation)` is a pure function. This is the *entire* interface the meta-agent
optimizes through — it never emits raw code or patches, so every change is
inspectable and bounded, and nothing it does can reach the FSM or the wire.

### The judge: an out-of-loop evaluator

`evaluate(logPath, task) → { score, passed, breakdown }` reads the finished
session's JSONL log (`readSessionLog`, already public) and applies the task's
checks: goal reached, tool-error count, turn count, artifact correctness. It is
a *consumer* of the log, downstream of the run — the agent under test cannot
influence it during the run, and the meta-agent is handed only the returned
result object, never the evaluator module. In production the evaluator SHOULD
run as a separate process for a hard trust boundary; the reference
implementation keeps it an isolated module invoked by the orchestrator (never by
the meta-agent) so the same guarantee holds structurally.

### One auto-evolve iteration

```
seed harness
  └─ runner: fork an isolated workspace+sessionsDir, compile harness→config,
     drive one session to done            → JSONL log
        └─ evaluator: read log             → score + weakness breakdown
             └─ if optimal: stop
                else: meta-agent proposes a bounded HarnessMutation
                        └─ applyMutation → candidate harness
                              └─ loop, keeping the best-scoring harness,
                                 stopping at budget or K rounds w/o gain
```

Isolation is per-run: each candidate runs in its own temp workspace and its own
`sessionsDir`, so a mutation can never corrupt the baseline or another
candidate.

## Alternatives considered

**Let the meta-agent edit arbitrary code (à la Darwin Gödel Machine).**
*Rejected.* Maximum optimization freedom, but it abandons both the "kernel
stays pure / readable" line and any tractable safety boundary — the agent could
rewrite the evaluator, the FSM, anything. Out of scope for a pedagogical
substrate; a typed harness surface is the disciplined subset.

**Bake evolve support into the host.** *Rejected* by decision 3. It would grow
the core for a feature most host users never invoke, diluting readability —
the same argument [ADR 0005](0005-kernel-boundary.md) makes for planning and
memory. A separate package keeps the core's line count and mental model fixed.

**Let the meta-agent call the evaluator directly / share its process.**
*Rejected* by decision 2. Any path from the optimized loop to the judge is a
reward-hacking surface. The orchestrator — not the meta-agent — invokes the
evaluator, and the meta-agent receives only the score.

**Require a live LLM for the reference experiment.** *Rejected.* The shipped
experiment must be reproducible in CI with no secrets, so it runs on a scripted
LLM. The meta-agent proposer is written against an `LLMAdapter` interface so a
real model drops in unchanged; a deterministic rule-based proposer backs the
reproducible run.

## Consequences

**Good**:
- The kernel and host core do not change; the readability promise is intact and
  the substrate is deletable without touching anything below it.
- The evaluator's out-of-loop position is structural, not conventional: the
  meta-agent has no import path to it.
- The harness surface is small, typed, and serializable, so every proposed
  change is reviewable and bounded — no free-form code generation.
- The JSONL log, already the system's durable record, doubles as the
  meta-agent's perception channel and the evaluator's input. No new core
  interface was needed.

**Bad**:
- The optimization space is deliberately narrower than "edit any code." A
  meta-agent cannot discover improvements that require FSM or protocol changes.
  Accepted: that is the point of the boundary this round.
- The reference evaluator is an in-process module, not a separate process, so
  the hard trust boundary is documented-and-structural rather than
  OS-enforced. A production deployment must promote it to its own process.
- Two proposer strategies (LLM + rule-based) must be kept in sync behind one
  `HarnessMutation` type.

## Verification

`packages/substrate` ships unit tests for `applyMutation`, the runner, the
evaluator, and the evolve loop, plus an executable experiment
(`examples/auto-evolve/`) that runs one full cycle on a concrete task with a
scripted LLM and prints a before/after report showing a measurable score gain.
The kernel, host, dashboard, and executor test suites and typechecks must remain
green — proof that nothing below the line moved.
