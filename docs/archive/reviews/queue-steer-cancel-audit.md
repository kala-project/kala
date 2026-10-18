# Queue, Steer and Cancel Audit

**Status:** implemented and verified
**Invariants:** S4–S7, S13

## Confirmed defects

1. Queue drain persisted removal before durable `user_message`; a crash in between lost accepted work.
2. Socket-level operation deduplication was memory-local and expired on Host restart.
3. Old Host Queue drains continued after `close()`, racing the replacement Host and duplicating a turn.
4. Multiple restart/hydration paths could request recovery around Queue drain.

## Changes

- Accepted queued messages carry a stable `operationId` into the durable Kernel event.
- Queue snapshots persist `operationId`; legacy snapshots fall back to queue item ID.
- Enqueue rejects an operation already queued or already present in durable Session history.
- Drain now commits `user_message` before removing the queue item.
- Restart recovery detects a committed operation and removes its stale queued copy without dispatching it twice.
- Drain stops at all close boundaries and never writes queue metadata after Host shutdown.
- Session resume is coalesced per Session.

## Evidence

- Direct-send retry and queued-send retry with the same operation ID produce one prompt.
- Queue restart reproduction passes repeatedly without duplicate LLM invocation.
- Existing tests cover reorder/update/delete, many queued messages, browser disconnect, Steer during LLM/Tool, and concurrent Cancel.
- Full Host suite: 113 files, 851 passed, 2 skipped.
- Kernel: 57 passed after additional approval lifecycle cases.

Remaining browser draft/IME/attachment behavior belongs to `composerInteractionAudit`.
