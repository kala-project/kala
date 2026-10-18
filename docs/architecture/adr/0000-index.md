# ADR 0000: Architecture Decision Record Index

An ADR captures the **context, decision, and consequences** of a non-obvious design choice. This directory holds one file per decision.

## Format

Each ADR follows this shape:

```
# ADR NNNN: <title>

Status: proposed | accepted | superseded by NNNN
Date: YYYY-MM-DD

## Context
What forces are at play? What constraints exist?

## Decision
What did we decide, in one sentence, then a paragraph.

## Alternatives considered
Options we weighed, with why each was rejected.

## Consequences
What follows from this decision — good and bad.
```

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-pure-reducer.md) | Kernel as a pure-function reducer | accepted |
| [0002](0002-reverse-websocket.md) | Executor dials out to Host (reverse WebSocket) | accepted |
| [0003](0003-socket-io.md) | Socket.IO as transport | accepted |
| [0004](0004-config-state-separation.md) | Separate `AgentConfig` from `AgentState` | accepted |
| [0005](0005-kernel-boundary.md) | Planning, memory, subagents live outside the kernel | accepted |
| [0006](0006-no-relay-process.md) | No separate relay process in v1 | accepted |
| [0007](0007-mcp-compatible-tools.md) | Tools use MCP-compatible schemas | accepted |
| [0008](0008-dashboard-vite-react.md) | Dashboard is a Vite + React SPA, not Next.js | accepted |
| [0009](0009-provider-adapter-strategy.md) | Provider adapters behind a thin `LLMAdapter` interface | accepted |
| [0010](0010-fsm-dispatch-table.md) | FSM as a hand-rolled dispatch table, not XState | accepted |
| [0011](0011-rename-host-and-core.md) | Rename `packages/core` → `packages/host`, `reducer.ts` → `core.ts` | accepted |
| [0013](0013-dashboard-finder-layout.md) | Dashboard Finder-style layout + control-plane events | accepted |
| [0014](../../meta/adr/0014-subagent-approval-mode.md) | Sub-agent sessions force `allow_all` approval mode | accepted |
| [0015](0015-self-improvement-substrate.md) | A substrate for self-improving meta-agents | accepted |
| [0016](0016-state-flow-management.md) | State flow management by layer | accepted |

## When to add an ADR

Add one when a decision (a) is non-obvious to a reader, (b) closes off a plausible alternative path, and (c) will be expensive to reverse. Don't ADR every choice — trivial ones just muddy the record.
