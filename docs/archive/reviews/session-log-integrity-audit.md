# Session Log Integrity Audit

**Status:** implemented and verified
**Invariants:** S1–S3, S13, S15
**Historical corpus:** read-only LXD logs described in `core-hardening-baseline-2026-07-31.md`

## Findings

1. `dispatchOne` could be entered outside the public per-Session turn tail by Cancel, recovery, Compact and effect callbacks.
2. `SessionStore.record` trusted a caller-computed `nextState.cursor`; two callers could persist the same sequence.
3. Event append returned before an explicit `fsync`, permitting acknowledged/broadcast state to be missing after a hard crash.
4. The reader accepted duplicate and regressing historical event sequences without warning.
5. Host shutdown did not stop an already scheduled Queue drain. In restart tests, the old Host could dispatch the persisted queued item after `close()`, while the new Host also restored it. This explained the previously flaky duplicate LLM call.
6. Restart recovery, dashboard hydration and Queue drain could independently request resume. Recovery needed one coalesced per-Session operation.

## Changes

- Added a per-store/per-Session commit critical section around read → reducer step → durable append → broadcast.
- Added a final `SessionStore.record` commit tail and strict `expectedCursor = current.cursor + 1` validation.
- Event entries now append through a file handle and `sync()` before in-memory state publication/broadcast.
- `readSessionLog` now:
  - rejects invalid event sequences;
  - keeps the first durable entry for duplicate legacy sequences;
  - drops regressing entries;
  - reports gaps and all drops through non-fatal warnings.
- Coalesced all Session resume paths with `ensureSessionResumed`.
- Host startup awaits marked restart recovery.
- Queue drain checks Host closed state before start, after waiting for an active turn and before dispatch.

## Compatibility policy for legacy logs

Legacy logs are never rewritten automatically. Read behavior is deterministic:

1. First valid durable event for a sequence wins.
2. Later duplicate sequence entries are ignored with a warning.
3. Regressing entries are ignored with a warning.
4. Forward gaps remain visible and are reported; valid later events are retained for forensic visibility.
5. Newly generated logs are not allowed to contain duplicates, regressions or gaps.

This policy avoids mutating 15 GiB of existing Session evidence while preventing impossible replay state.

## Regression evidence

Focused and package-wide verification:

- Host typecheck passed.
- `src/store/log.test.ts`, `src/store/session.test.ts`, `src/loop.test.ts` passed.
- Added duplicate/regression/gap reader tests.
- Added concurrent stale `record()` rejection test.
- Existing 12-way concurrent Cancel test verifies one persisted Cancel and unique sequences.
- Queue restart reproduction passed 10 consecutive isolated runs after the close/drain fix.
- Full Host suite: **113 files passed; 851 tests passed; 2 skipped**.

## Remaining ownership

- Crash-atomic Queue dequeue/dispatch handoff remains under `queueSteerCancelAudit`.
- Full authoritative Dashboard conflict replacement remains under `dashboardProjectionAudit`.
- Crash after unsafe Executor mutation and before receipt remains under `executorProtocolReliabilityAudit` and `restartRecoveryAudit`.
