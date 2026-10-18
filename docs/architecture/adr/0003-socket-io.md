# ADR 0003: Socket.IO as transport

**Status**: accepted
**Date**: 2026-07-04

## Context

Host, Dashboard, and Executor need to exchange events over the network. Requirements:

- Bidirectional (Host pushes to Executor for tool calls; Executor replies; Dashboard subscribes to state changes)
- Client-initiated connections (see [ADR 0002](0002-reverse-websocket.md))
- Node client + browser client (same protocol)
- Auto-reconnect
- Per-session routing (multiple sessions must not leak state to each other)
- Request-reply correlation for tool calls (call → result with matching `callId`)

## Decision

**Use Socket.IO 4.x.** Server in Host, clients in Executor (Node) and Dashboard (browser).

Uses:
- Two **namespaces** (`/dashboard`, `/executor`) for role separation
- **Rooms** named `session:<id>` for per-session fan-out
- Native **ACKs** for tool-call request/response correlation
- Native **auth** middleware for handshake token validation
- Native **reconnection** for network transience

## Alternatives considered

**Raw WebSocket (`ws` in Node, `WebSocket` in browser).** Would work. We'd re-implement rooms, ACKs, reconnection, event names on top. Estimated cost: ~150 LOC in shared code, 3× the surface area of bugs. Rejected.

**gRPC / gRPC-Web.** Excellent typing story; poor browser story (needs a proxy). The protocol lock-in is heavy for what's ultimately event-shaped traffic. Rejected.

**Server-Sent Events + HTTP POST.** SSE is one-way (server→client), so we'd need HTTP POST for client→server. That gives up ordering guarantees and connection reuse. Rejected.

**HTTP long-polling / short-polling.** Latency floor is too high for interactive UI. Rejected.

**Message queue (Redis / NATS / Kafka).** Great for distributed backends, wrong tool for edge-to-edge (browser and laptop clients). Rejected for v1. May sit *behind* Socket.IO in v2 as a horizontal-scaling layer.

## Consequences

**Good**:
- Rooms are one-liner per-session routing. No hand-rolled subscription table.
- ACK with timeout is native: `io.to(room).timeout(30_000).emit('tool:call', payload, (err, res) => ...)`. Matches our request-reply need exactly.
- Reconnection is free.
- Node + browser client packages are officially maintained; parity is high.
- Instrumentation (`socket.io-admin-ui`) is a nice-to-have for debugging traffic.

**Bad**:
- Socket.IO's wire protocol adds a small envelope overhead (~10-20 bytes per message) compared to raw WS. Irrelevant at our scale.
- We inherit Socket.IO's semantics — including its "engine.io" transport fallback (polling if WS fails). Fine, but a foot-gun if you assume "WebSocket only." We don't need to police this.
- Vendor lock. Migrating to something else means rewriting the transport layer. Acceptable given the payoff.

## Verification

The wire protocol is specified independently of Socket.IO in [wire-protocol.md](../../protocol/wire-protocol.md). If Socket.IO ever needs to be replaced, that doc is the contract to hold onto — Socket.IO event names and payload shapes are the only Socket.IO-specific things.
