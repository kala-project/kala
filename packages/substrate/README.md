# @agent-kernel/substrate

A **self-improvement substrate**: run a *meta-agent* that improves a coding
agent's **harness** through a real **auto-evolve** loop — run, judge, propose a
change, re-run, keep what's better — all **without touching the kernel or the
host core**.

This is the platform layer of [ADR 0015](../../docs/architecture/adr/0015-self-improvement-substrate.md).
It sits entirely above `@agent-kernel/host`'s public API and reads the JSONL
event log the system already produces. Delete this package and everything below
it runs unchanged.

---

## The idea

An agent's behaviour is shaped by its *harness*: its system prompt, the tools it
is offered, and a few bounded knobs. A meta-agent watches how the agent did on a
task, proposes **one small change to that harness**, and an out-of-loop
evaluator decides whether the change actually helped. Repeat, keeping the best.

```
seed harness
  └─ runner: fork isolated world, run one session   → JSONL log
       └─ evaluator (out of loop): read log          → score + weakness
            └─ meta-agent: propose ONE HarnessMutation
                 └─ applyMutation → candidate → re-run → adopt if better
```

Two invariants make this safe rather than a reward-hacking machine:

1. **The meta-agent may change only the harness** — system prompt, tool set,
   extension knobs. Never the FSM, never the wire protocol. Its whole vocabulary
   is the typed `HarnessMutation` union; it never emits raw code.
2. **The evaluator lives outside the meta-agent's reach.** The evolve
   orchestrator is the only caller of the evaluator; the meta-agent receives
   only the resulting score. It has no import path to the judge.

## Components

| Module | Role |
|---|---|
| `harness.ts` | The `Harness` spec + `HarnessMutation` union + pure `applyMutation`. The entire programmable surface. |
| `runner.ts` | `runTask(harness, task, llm)` — forks an isolated world, compiles the harness into an `AgentConfig`, drives one session through the real `runHostLoop`. |
| `evaluator.ts` | `evaluate(logPath, goalCheck)` — reads the JSONL log, returns a score + weakness breakdown. Out-of-loop judge. |
| `meta-agent.ts` | `ruleMetaAgent` (deterministic) and `llmMetaAgent` (real model) — both propose a `HarnessMutation` from a trajectory. |
| `evolve.ts` | `evolve(...)` — the loop that ties them together and enforces the boundary (it, not the meta-agent, calls the evaluator). |

## Run the demo

```bash
pnpm --filter @agent-kernel/substrate exec tsx examples/auto-evolve/run.ts
```

It starts from a weak harness whose agent writes `config.json` with a trailing
comma (invalid JSON) and never checks its work. The meta-agent reads the failing
run, appends a "produce valid JSON and validate before finishing" instruction,
and the loop adopts it:

```
round 0 [seed ] score=0.00 passed=false
round 1 [ADOPT] score=0.95 passed=true  ← append to system prompt: "Produce strictly valid JSON…"
seed 0.00 → best 0.95 (IMPROVED)
```

The demo is fully deterministic — a scripted LLM models "a better prompt yields
a better agent", so it runs in CI with no API keys. Swap in a real `LLMAdapter`
and `llmMetaAgent(model)` to run the identical loop against a live model.

## What this deliberately does NOT do

- It does not let the meta-agent edit arbitrary code (cf. Darwin Gödel Machine).
  The harness surface is a disciplined, typed subset.
- It does not modify `@agent-kernel/kernel` or the host core. Every capability
  here is bolted on and deletable.
- The reference evaluator is an in-process module, not a separate process. The
  trust boundary is structural (no import path from the meta-agent) and
  documented; a production deployment should promote it to its own process.

## References

- [ADR 0015](../../docs/architecture/adr/0015-self-improvement-substrate.md) — the design and its boundaries
- [ADR 0005](../../docs/architecture/adr/0005-kernel-boundary.md) — why planning/memory/self-improvement live outside the kernel
