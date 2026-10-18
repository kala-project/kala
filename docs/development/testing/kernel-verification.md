# Kernel verification

**Status:** Normative verification contract

Kala's Kernel is a deterministic pure-function state machine:

```text
step(state, event, config) -> { next, effects, transition }
```

Verification applies to this reducer boundary. It does not turn statements
about providers, tools, networks, filesystems, or host schedulers into Kernel
claims.

## Claims

The verification suite continuously checks these properties:

1. **Transition completeness.** Every `AgentStatus` and `AgentEvent.kind` pair
   is explicitly classified as handled or ignored. A handled event may still
   be rejected when its payload does not match the current state.
2. **Determinism.** Equal state, event, and config values produce equal state,
   effects, and transition diagnostics.
3. **Input immutability.** `step` does not mutate state, event, or config.
4. **Cursor monotonicity.** Every invocation advances the cursor exactly once,
   including ignored and rejected events.
5. **Invariant preservation.** A transition from a valid state cannot produce
   a state that violates the status, pending-call, or error invariants.
6. **Approval safety.** A call that is waiting for approval cannot produce a
   `call_tool` effect before the matching approval event.
7. **Result correlation.** A tool result can settle only the matching
   dispatched call. Unknown, stale, and duplicate results are rejected.
8. **Bounded asynchronous progress.** In the formal abstraction, a waiting
   state can make progress when the environment eventually supplies an LLM
   response, approval decision, tool result, error, or cancellation.

The executable transition matrix, property-based event traces, and formal model
are complementary:

- TypeScript exhaustively checks the real reducer over every status/event-kind
  cell.
- Fast-check explores payloads and event sequences and shrinks failures to a
  reproducible trace.
- TLA+ explores asynchronous ordering in a finite abstraction and checks safety,
  deadlock freedom, and progress under stated fairness assumptions.
- A generated TLA+ contract is checked against the exported TypeScript
  transition matrix so adding a status or event cannot silently leave the
  formal model stale.

## Assumptions

Safety properties require only a valid input state. Progress properties require
environment fairness: an outstanding LLM request, approval request, or tool
call eventually receives a response, failure, or cancellation event. Without
that assumption, an external operation may remain pending forever and no
Kernel-only proof can claim otherwise.

The finite formal model abstracts message text, tool input, provider payloads,
and call identifiers. Those values are covered by TypeScript property tests
where they affect reducer behavior.

## Non-claims

Kernel verification does not prove:

- that an LLM response is correct or eventually arrives;
- that a tool is safe, terminates, or faithfully reports its result;
- that a host persists and delivers events exactly once;
- that network, process, storage, or workspace implementations are correct;
- that every possible product requirement is represented by the current state
  and event algebra.

Those are Runtime, protocol, deployment, and product verification concerns.
The Kernel claim is deliberately narrower: its defined state/event algebra is
transition-complete, deterministic, invariant-preserving, and safe across the
verified asynchronous interleavings.
