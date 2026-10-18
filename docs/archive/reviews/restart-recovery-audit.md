# Restart and Recovery Audit

**Status:** focused implementation complete
**Invariants:** S5–S7, S10–S14

## Findings and fixes

- Recovery entry points were split between RestartCoordinator, dashboard hydration and Queue drain. They now converge through coalesced `ensureSessionResumed`.
- Marked restart recovery is awaited during Host startup rather than detached.
- Old Host Queue workers now stop at close boundaries, preventing replacement-Host duplicate turns.
- Queue operations carry durable identities and use dispatch-before-dequeue recovery semantics.
- Executor receipts are Session-scoped and enabled in Hosted loopback Units.
- Approval state remains durable and is intentionally not auto-executed after restart.

## Evidence

- Queue/active-turn restart integration repeatedly produces one continuation and no synthetic `[interrupted]` result.
- Restart planner covers thinking, executing tools, approval, idle/done and missing Sessions.
- Restart workflow and coordinator suites pass.
- Full Host suite passes: 113 files, 851 tests, 2 skipped.
- Executor suite passes: 29 files, 165 tests.

Sub-agent parent/child reconstruction and orphan cleanup is owned by the immediately following `subagentTaskGraphAudit`.
