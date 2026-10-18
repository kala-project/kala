# Socket.IO Reliability Plan

## Goals

- Every mutating dashboard operation has an explicit persisted/committed acknowledgement.
- Retries are safe through stable operation IDs and host-side deduplication.
- Tool calls terminate by an absolute deadline and survive socket replacement without duplicate execution.
- Short disconnects recover Socket.IO packets; session history remains the authoritative fallback.
- Dashboard and executor reconnect indefinitely with bounded jittered backoff.
- Connection health and pending-tool age are observable.
- Large artifacts/history remain outside latency-sensitive control RPCs.

## Delivery classes

1. **Ephemeral projection**: token deltas and transient status. Socket recovery is useful; authoritative state/history repairs gaps.
2. **Idempotent reads**: list/read/status. Use `timeout().emitWithAck()` and bounded retries.
3. **Mutations**: rename, preferences, approvals, queues, create/delete, user messages. Carry `operationId`; host stores completed ACK envelopes and returns the same result for duplicates.
4. **Long-running tool calls**: retain host pending registry, absolute deadline, cancel propagation, call-ID idempotency, reconnect redispatch, and executor ACK fan-out. Socket.IO ACK is transport only.

## Socket configuration

- Server: connection-state recovery, explicit heartbeat, bounded packet buffer window.
- Dashboard: WebSocket with polling fallback, infinite reconnect, online/visibility-triggered reconnect.
- Executor: infinite reconnect with 60-second maximum delay.

## Acceptance

- Duplicate mutation operation IDs execute once and return the original ACK.
- A user message ACK means the host accepted it into durable/session processing, not merely that a frame arrived.
- Reconnect does not extend tool deadlines.
- In-flight duplicate tool calls execute once and reply to replacement sockets.
- Recovery, timeout, late ACK, cancellation, duplicate operation, and process-restart cases have automated tests.
