# ADR 0014: Sub-agent sessions force `allow_all` approval mode

Status: accepted
Date: 2026-07-06

## Current scope (2026-10-25)

The [deployment-mode contract](../../architecture/deployment-mode-contract.md), especially Unit isolation/delegation, is the target SoT. This ADR preserves the headless approval-FSM decision, **not** its original implication of unrestricted descendant authority. Current children use the same Unit Session authority (JSONL is a legacy implementation detail), inherit the authorized Workspace/CWD, and receive only parent/role/explicit-allowlist-intersected tools. Research/review are read-only; implementation/test retain their respective policies. `allow_all` suppresses human approval waits, not server authorization, owner/device fences, role limits or sandbox constraints. Explicit smaller positive budgets must not be expanded by role defaults. Child history needs its own scoped/owner-routed transport in Dedicated/Private Cloud, not a broader parent ticket.

The statements below about the same tool set and implicit authorization of every descendant tool describe the original v1 tradeoff and are superseded by this scope. They are not a separate current security contract. Parent-proxied per-tool approval remains a possible future UX, not a reason to disable role or tenancy checks today.

## Context

The host-side `agent` builtin spawns a **child session** under the same workspace. The child runs the same kernel loop, the same tool set, and the same executor as its parent — but crucially, **no dashboard is attached to it**. Dashboards subscribe to a specific `sessionId` on the `/dashboard` Socket.IO namespace; a headless child session is never subscribed by any client.

The kernel enforces the approval FSM uniformly: when the current `AgentState.approvalMode` requires approval for a tool call (per the tool's `requiresApproval` flag and the mode's rules), it emits a `RequestApprovalEffect` and parks the pending call in `awaiting_approval`. The state advances only when an `approve` or `reject` event lands.

Before this decision, `loop.ts` seeded the child's initial approval mode by copying the parent's mode:

```ts
initialApprovalMode: parent.state.approvalMode
```

That meant a parent in `auto` (the default) or `ask` produced a child that could park on `awaiting_approval` for any `requiresApproval: true` tool (currently `bash` and `edit`/`write`). With no dashboard listening on the child, the request effect went nowhere and the child hung until its outer `dispatchOne` returned — at which point the parent's `agent` tool saw `status: 'awaiting_approval'`, not `'done'`, and reported `tool_result: ok=false, "agent ended with status awaiting_approval"`.

This wasn't a rare edge case — it fired the first time any auto/ask parent asked its sub-agent to run bash.

## Decision

**Sub-agent sessions always start with `initialApprovalMode: 'allow_all'`, regardless of the parent's mode.**

Sub-agents run headless. Every effective operator of a sub-agent is the parent agent, not the human — and the parent has already been sanctioned (implicitly, by the user having created its parent chain). Making the sub-agent block on approvals nobody can grant is worse than letting it act: it turns every meaningful sub-agent invocation into an opaque failure.

## Alternatives considered

- **B. Proxy approvals from child up to parent's dashboard.** Semantically the "right" answer: the human still gates every tool call the sub-agent wants to run, but the UI aggregates them into the parent's session view. Rejected for v1 because it doubles the approval-request wire protocol (child requests → host relays to parent → parent dashboard prompts → response threads back through the child), and it front-loads engineering work on a UX we haven't validated. Revisit if sub-agents become a heavier surface.
- **C. Inherit and fail fast** (with a clearer error). Preserves the parent's safety posture but makes the `agent` builtin nearly useless whenever the parent isn't in `allow_all` — since `bash` is the most useful thing to delegate. Rejected: correct behavior but useless.
- **D. Per-tool safelist for sub-agents.** Approve `read`/`ls`/`grep` unconditionally, deny `bash`/`edit`/`write` unconditionally. More surface area than either A or C, and it removes the parent's ability to delegate exactly the tools that matter most. Rejected as premature.

## Consequences

**Good:**
- The `agent` builtin actually works from any parent approval mode.
- No dead-code paths on the child (approval FSM still evaluates, it just never triggers).
- One-line implementation, easy to reverse when we pick a follow-up.

**Bad — deliberate:**
- A parent set to `auto` or `ask` cannot enforce that same posture on its sub-agents. The security boundary is the *parent chain*: whoever authorized the top-level session has implicitly authorized any tool call any descendant makes.
- The `KALA_ALLOW_ALL_OK=1` env-gate on `allow_all` at the *dashboard-facing* API is bypassed for child sessions. This is intentional (the child is not human-facing), but worth noting for future security review.
- A malicious or buggy sub-agent prompt can execute arbitrary bash without a second confirmation. The mitigation today is the `maxAgentDepth` recursion guard and the sandboxed workspace roots — not per-call approval.

**Follow-up:**
- If sub-agents become a first-class UX (parallel research fan-out, judge panels, long-running background sub-tasks), revisit alternative B — proxy approvals through the parent dashboard. Track the decision here or supersede this ADR.
- Consider surfacing "sub-agent is running in `allow_all`" in the dashboard's session-info panel so the human operator understands the child's effective posture.
