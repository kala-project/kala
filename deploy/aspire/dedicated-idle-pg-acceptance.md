# Dedicated idle PostgreSQL load repair

Runtime source `00685518`; Gateway remains the verified `346b92fc` build. Applied to the retained Dedicated LXD through the formal exact-image, no-migration cold-backup upgrade, not a hot patch.

## Root cause and repair

The default scheduler polled every second. `readState()` renewed the writer lease even for reads, and empty `claimedRuns()` entered another writable recovery transaction. This produced 45 scheduled-state index scans and 48 scheduler-lease updates during the observed 15.15-second baseline.

Exclusive reads now verify current namespace/Unit/owner/generation/expiry in PostgreSQL without renewal; empty recovery scans return without entering a write transaction. Placement checks, actual mutation fences and periodic heartbeat remain. Parallel-v1 ownership checks remain covered by real PostgreSQL integration tests. No SQL telemetry was disabled or filtered.

Default calendar discovery is now every 30 seconds, with up to 30 seconds of polling delay plus processing time. Existing explicit `pollMs` callers are unchanged.

## Actual deployment acceptance

A 60.061-second post-upgrade observation without a load generator recorded:

| Counter | Before / second | After / second | Reduction |
|---|---:|---:|---:|
| Scheduled-state index scans | 2.970 | 0.067 | 97.8% |
| Scheduler writer-lease updates | 3.168 | 0.200 | 93.7% |

These are specific counter reductions, not a claim that all SQL or all maintenance traffic disappeared. The after window had 4 scheduled-state scans, 12 scheduler-lease updates and no transaction rollback. Necessary placement/membership/leader renewal remains.

53 focused tests including a real temporary PostgreSQL, read-without-renewal and expired/replaced-owner/generation negatives passed; Host typecheck passed. Actual Session-list/memo/tab reads remain 200, each with a genuine Gateway→Runtime→PG chain; anonymous/Origin/service-boundary negatives still reject.

Aspire's volatile historical noise was cleared by recreating only its viewer; business data and recovery artifacts were not deleted. The v3 cold backup validates all 1999 entries across five roots, and the original TLS CA is unchanged. This is not a cold-restore, real-browser, configured-model or Executor acceptance.

Exact image, counters and redacted machine evidence: [dedicated-idle-pg-acceptance.json](./dedicated-idle-pg-acceptance.json).
