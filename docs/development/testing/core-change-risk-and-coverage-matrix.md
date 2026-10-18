# Core Change Risk and Coverage Matrix

**Baseline:** `1e01821a46f05b703db6fc97b6cd61cb6d179dc4` plus 213-path shared working tree
**Invariants:** [`../architecture/core-agent-invariants-and-fault-model.md`](../../architecture/core-agent-invariants-and-fault-model.md)
**Rule:** structural reuse and passing unit tests are not acceptance evidence.

## Change concentration

The tracked core delta contains 102 files and 4,849 changed lines. Concentration is highest in Dashboard `app.tsx`, Composer/ChatPanel/VirtualTranscript, Host loop/server/compaction, shared protocol, Executor client and newly added Platform routing/tenant-runtime files. New untracked files are included in review even though `git diff <base>` alone does not list them.

## Risk matrix

| Surface / files | Primary invariants | Existing evidence | Gap / required next test | Risk |
|---|---|---|---|---|
| Kernel reducer: `core.ts`, `handlers.ts`, `types.ts` | I1–I8, S7–S9, S11 | reducer examples and property tests; cancel/error pending-call defenses | random legal/illegal event model; replacement with active parallel calls; late/duplicate result sequences | High |
| Host serialization: `loop.ts`, `store/session.ts`, `store/log.ts` | S1–S3 | focused concurrent Cancel test; replay/store tests | one serialization boundary for every mutation; concurrent record append; delayed/failing append; duplicate legacy sequence policy | **Critical** |
| Queue manager: `server.ts`, `dashboard-ns.ts` | S4–S6, S13 | queue persistence/restart, steer-running tests | crash between dequeue and dispatch; concurrent edit/delete/drain; ACK loss and multi-device operation replay | **Critical** |
| Approval and Tool lifecycle: Kernel handlers, Host loop/executor registry | S7–S10 | partial parallel call and cancel tests | duplicate decision, role revocation, late result, result-before-call, wrong Executor/Workspace, reconnect during partial group | Critical |
| Compact/context: `extensions/compaction.ts`, `context/manager.ts`, `loop.ts` | S11–S13 | hard pressure, oversized item, provider overflow, no-progress and mid-tool tests | repeated failure/breaker model, crash around commit/resume, active call boundary proof, multiple consecutive compactions | Critical |
| Restart: `restart-coordinator.ts`, `restart/*`, `loop.ts` | S5–S7, S10–S14 | planner/workflow tests and one live deployment recovery | phase matrix for LLM/tool/approval/queue/compact/sub-agent; exactly-once effect after crash | Critical |
| Executor idempotency: `executor/client.ts`, `execution-receipts.ts` | S8, S10, S13 | duplicate concurrent/completed call tests; receipt persistence tests | receipt key is currently only `callId`; test same ID across Session/Workspace/generation; Platform loopback disables receipt persistence | **Critical** |
| Executor wire schema: shared executor protocol | S8, S10, S18 | schema and handshake tests | scoped operation identity/generation absent; wrong-scope result rejection and version mismatch | Critical |
| Tenant runtime composition: `host/tenant-runtime/*` | S10, S13, S17, S18 | identical Session/Workspace ID isolation; artifact isolation | Platform receipts disabled; restart equivalence; cleanup/background operation isolation | Critical |
| Runtime ingress Gateway: `runtime-ingress-gateway/*` | S17–S20 | identity-derived Unit routing, header stripping, fail-closed unknown Unit | WebSocket currently gates only `runtime:read` although channel carries mutations; stale mapping/reconnect; secret canaries | **Critical** |
| Composer: `Composer.tsx`, `app.tsx`, `transcript.ts` | S4, S19 | immediate clear, failed ACK restoration, unrelated edit preservation | integrated lost ACK/retry with one operation; multi-tab send; attachment/IME/auth failure and reconnect | Critical |
| Session projection/cache: `session.ts`, `session-projection.ts`, cache modules | S15, S16, S19 | duplicate/out-of-order projection and cursor rollback tests | authoritative full-history replacement of conflicting live entry; corrupt IndexedDB; identity switch; cache→history→stream convergence | Critical |
| Chat rendering: `ChatPanel.tsx`, `VirtualTranscript.tsx`, transcript keys | S15, S16 | tool grouping, Compact boundary, historical orphan regression, streaming code stability | persistent event identity versus position keys; pagination/corrupt log; result-before-call; virtual unmount/remount | High |
| Auth/UI shell: `auth-session.ts`, account/settings/error surfaces | S18–S20 | component auth and product-state tests | real logout/401 stopping socket and background retries; cache partition after identity switch | High |
| Artifact/audit/support paths | S18, S20 | hashed tokens, encrypted refresh token, some redaction | secret canaries through errors, logs, artifacts, support exports and control persistence | High |
| Dedicated/Private Cloud equivalence | S17 | shared Runtime Host composition is structurally promising | paired identical event sequence and Executor result must produce equivalent final state and transcript in both configurations | Critical |

## Confirmed defects carried into focused audits

1. Historical LXD logs contain duplicate sequences (22 in the primary long Session, one in another Session).
2. Session mutation is not uniformly guarded by one durable serialization primitive; direct `SessionStore.record` trusts caller-computed `nextState.cursor`.
3. Executor receipt identity is under-scoped (`callId` only).
4. Platform loopback disables durable Executor receipt storage.
5. Gateway WebSocket authorization does not distinguish read from mutating events.
6. Full-history replay currently preserves some conflicting live entries rather than always converging to authoritative history.
7. Queue dequeue and user-message dispatch are separate durable operations, leaving a crash-loss window.
8. Permanent historical message keys use array position to preserve stream handoff, creating identity risk when history is inserted/reordered.

## Audit ownership

| Graph node | Must close |
|---|---|
| `sessionLogIntegrityAudit` | S1–S3 and findings 1–2, plus projection handling of legacy duplicate logs |
| `queueSteerCancelAudit` | S4–S7 and finding 7 |
| `approvalToolLifecycleAudit` | S7–S10 |
| `compactionAdversarialAudit` | S11–S12 |
| `executorProtocolReliabilityAudit` | S8, S10, S13 and findings 3–4 |
| `restartRecoveryAudit` | S5–S7, S10–S14 |
| `dashboardProjectionAudit` | S15–S16 and findings 6, 8 |
| `composerInteractionAudit` | S4, S19 |
| `multiTenantCoreIsolationAudit` | S17–S20 and finding 5 |

## Exit condition

The map is complete only when every critical row has a downstream graph owner and no critical claim relies solely on code shape or a mocked unit test. This document assigns every critical row accordingly; resolution remains the responsibility of the listed audit nodes.
