# Codebase Efficiency Review — 2026-07

## Scope

Static and automated review of the critical Dashboard, Host/Kernel, Executor, Shared protocol, PWA, compaction, queue, and persistence paths. Existing correctness and reliability invariants take priority over throughput.

## Baseline

- Full workspace tests, type checks, production build, mobile/PWA browser matrix, and perf-harness regression command.
- Current perf harness has four scenarios, but three remain opt-in/skipped in the default regression command. This limits quantitative regression detection and is tracked below.

## Implemented low-risk improvements

1. **Executor `read_files` output assembly**
   - Replaced repeated `chunks.join()` plus full UTF-8 recount with an incremental byte counter.
   - Added UTF-8-safe truncation and a hard output-budget test.
   - Removes quadratic output assembly for multi-file reads.

2. **Host context snapshot accounting**
   - Replaced three filtered arrays and four transcript estimations with one message pass.
   - Preserves the exact estimator and role-breakdown semantics while reducing scans and allocations.

3. **PWA update checks**
   - Added in-flight and five-second deduplication across visibility/focus events.
   - Polling and explicit user checks remain forceable.

## Prioritized follow-up backlog

### P0 — measured next

1. **Compaction suffix-token accounting**
   - `extensions/compaction.ts` repeatedly estimates overlapping tails and can become quadratic in message count.
   - Precompute per-message token estimates and suffix sums without changing tool-call grouping or preserve boundaries.

2. **Executor receipt persistence queue**
   - Every completion rewrites the receipt JSON and concurrent writers share a temporary path.
   - Introduce one serialized writer and burst coalescing while preserving the durable-before-ACK contract.

3. **Host token-delta batching**
   - Provider chunks currently produce one Socket.IO packet each.
   - Batch per session for 10–20 ms and flush before terminal/error/cancel events.

4. **Dashboard transcript incremental projection**
   - `ChatPanel` still performs whole-transcript grouping/projection work when the live tail changes.
   - First merge duplicate scans; then benchmark an append-only fast path with full-rebuild fallback.

### P1

5. Reduce PWA precache scope so lazy Shiki languages/themes and optional pages are not downloaded on every service-worker update.
6. Lazy-load heavyweight Settings sections behind local Suspense boundaries.
7. Stream large `read_file` windows rather than reading/splitting the whole file.
8. Bound `stat` concurrency in directory listing and reduce per-file metadata I/O.
9. Maintain an incremental in-memory session-summary index instead of periodic synchronous directory/stat/log scans.
10. Coalesce message-queue snapshots without weakening crash durability.

## Explicit non-goals / safety constraints

- Do not broadcast before session events are persisted.
- Do not remove per-session dispatch serialization.
- Do not parallelize sibling tool-result reducer dispatches.
- Do not weaken Kernel state invariants.
- Do not change compaction tool-call grouping or preserve boundaries as part of a performance-only edit.
- Do not replace authoritative state/event messages with lossy volatile packets without cursor gap detection and snapshot repair.

## Verification policy

Every optimization must have a focused equivalence or budget test, then pass workspace typecheck/build and affected package tests. Dashboard/PWA changes also run the mobile browser matrix. Changes to event dispatch, persistence, compaction, queues, or receipts require full workspace tests before deployment.
