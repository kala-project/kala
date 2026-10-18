# @agent-kernel/shared

Wire-protocol types shared by Host, Executor, and Dashboard. **Types only** — no runtime code, no dependencies.

---

## Why this package exists

Three separate packages need to agree on the shape of every event that crosses the Socket.IO wire. If Host defines `ToolCallPayload` and Dashboard defines its own copy, they'll drift. So the source of truth lives here, and everyone imports it.

## What it contains

- Socket.IO event payload types matching [`docs/protocol/wire-protocol.md`](../../docs/protocol/wire-protocol.md) — every `client:*`, `state:*`, `event:*`, `tool:*`, `executor:*` payload.
- Handshake auth type.
- Error envelope types (`WireError`, `AuthFailure`, etc.).
- JSONL log entry types matching [`docs/protocol/event-log.md`](../../docs/protocol/event-log.md) — `HeaderEntry`, `EventEntry`, `SnapshotEntry`.

## What it does NOT contain

- Kernel types like `AgentState`, `AgentEvent`, `Effect`. Those live in [`@agent-kernel/kernel`](../kernel/) and this package **re-exports** them so consumers can import everything from one place. See [ADR 0004](../../docs/architecture/adr/0004-config-state-separation.md).
- Any runtime code. Import-only. No side effects on load.

## Usage

```typescript
import type {
  // wire payloads (defined here)
  HandshakeAuth, ClientUserMessagePayload, StateChangedPayload,
  ToolCallPayload, ToolResultPayload,
  // log entries (defined here)
  HeaderEntry, EventEntry, SnapshotEntry,
  // kernel types (re-exported from @agent-kernel/kernel)
  AgentState, AgentEvent, AgentConfig,
} from '@agent-kernel/shared'
```

## Versioning

The wire protocol has a `protocolVersion` (in the handshake) and the event log has a `version` (in the header). Bumping either is a breaking change; add a migration note to the corresponding protocol doc and bump the package version.

## References

- Wire protocol: [`docs/protocol/wire-protocol.md`](../../docs/protocol/wire-protocol.md)
- Event log format: [`docs/protocol/event-log.md`](../../docs/protocol/event-log.md)
- Kernel types: [`@agent-kernel/kernel`](../kernel/) — the canonical source for `AgentState` etc.
