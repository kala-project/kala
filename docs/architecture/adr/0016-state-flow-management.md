# ADR 0016: Manage state flow by layer

**Status**: accepted
**Date**: 2026-07-24

## Decision

Use pure typed transitions in every stateful domain, while choosing the runtime
mechanism by ownership boundary:

- Kernel keeps its zero-dependency dispatch-table reducer.
- Host long-running workflows use serialized local actors around pure reducers.
- Dashboard session projection uses one React reducer plus a separate buffered streaming channel.

All async Host results carry attempt identity, all Kernel transitions report a
disposition, and model/property tests exercise generated event sequences.

## Rationale

A single state-machine library would not remove the difficult parts: ownership,
durability, stale async completion, and authority between server and browser. A
shared transition discipline addresses those problems while preserving the pure
Kernel and avoiding a global runtime dependency.

## Detailed Design

See [`../../architecture/state-flow-management.md`](../state-flow-management.md).
