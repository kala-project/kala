# DAG-first agent work

**Status:** Implemented product capability and user-facing contract.

Kala treats complex agent work as a dependency graph, not only as a linear conversation or flat checklist. The graph makes planned work, dependency order, parallel opportunities, blocked nodes, and completion state visible and durable.

## Two complementary surfaces

### Task Graph in normal Sessions

Every normal Chat Session can use the Host-owned `todo_graph` tool. The tool writes a versioned graph snapshot with nodes, edges, priorities, statuses, ready work, and blocked work.

The Dashboard derives the **Task Graph** button from successful `todo_graph` results. Users can open it from the Composer and switch between:

- a graph view for dependency structure and parallel branches;
- a grouped list for active, ready, blocked, and completed work;
- compact and expanded layouts that remain usable on narrow screens.

The latest successful revision is durable Session state. It participates in replay and recovery rather than existing only in model prose. Active or ready graph nodes also provide an explicit autonomous-work obligation, so interruption recovery can continue unfinished work without inventing a new plan.

### DAG execution mode

`executionMode: 'dag'` is a dedicated workspace for objectives that benefit from isolated worker Sessions. Kala stores an authoritative `DagRun` containing versioned nodes and edges, child Session links, decisions, graph history, and an append-only event projection.

The Dashboard exposes Graph, Activity, and Result views. Runtime updates are operation-id protected and broadcast as authoritative graph changes. Standard Chat Sessions cannot silently become DAG runs; the execution mode is selected when the Session is created.

## Product principles

1. **Dependencies are first-class.** A node can be ready only when its prerequisites are satisfied.
2. **Parallelism is visible.** Independent branches can proceed concurrently without hiding their relationship to the objective.
3. **Blocked work is explicit.** The graph records what a node is waiting on instead of presenting inactivity as progress.
4. **Graph revisions are durable.** Recovery, replay, and inspection use persisted revisions rather than reconstructed model narration.
5. **Execution remains bounded.** Child Sessions, approvals, workspace access, cancellation, and failure retain their existing authority boundaries.

## Why DAG-first matters

Long-running work rarely follows a single straight line. It usually mixes discovery, implementation, documentation, validation, and release tasks with different dependencies. A durable graph lets Kala expose that structure to both the agent and the user, making progress easier to inspect and failure easier to recover.

## Related contracts

- [`todo_graph` and Host-owned tools](../reference/executor/tools.md)
- [DAG wire lifecycle](../protocol/wire-protocol.md)
- [Sub-agent lifecycle](../host/sub-agent-design.md)
- [Task Graph recovery incident and contract](../archive/incidents/compact-auto-resume-incident-2026-07-31.md)
