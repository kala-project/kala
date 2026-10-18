# Dashboard Product Readiness Plan

**Status:** historical coordinating plan; non-normative and not current implementation evidence.

Status: active / incremental delivery
Owner: dashboard + host
Last updated: 2026-07-28

This is the coordinating plan for moving Agent RunLab from a capable engineering workbench to a predictable business product. It does not replace component designs. It records cross-cutting decisions, phase boundaries, evidence, and remaining risk, while linking to the existing source-of-truth documents.

## 1. Existing principles

All work in this plan follows these repository constraints:

- Use user-task language and hide implementation details by default [1].
- A workflow that requires dwelling, comparison, or return visits is a page, not a modal [1].
- Long operations expose real progress; a backend-only progress record is not user feedback [1].
- Dashboard changes require production-shaped headless-browser interaction and screenshots [1][2].
- Keep the work surface quiet and operational signals truthful; decorative motion must not distort real progress [3].
- Keep Kernel deterministic. Notifications, audit, transport health, telemetry, and release orchestration remain Host or Dashboard concerns [1].
- Implement concrete, independently reversible slices; do not introduce a second source of truth or speculative framework [1].
- Session JSONL and Kernel state are authoritative. Browser caches, Socket.IO packets, and React state are repairable projections [4][5].

## 2. Product success criteria

A mature release must make five facts obvious without requiring knowledge of internal architecture:

1. Which workspace and session are active.
2. Whether the agent is working, waiting for the user, recovering, offline, complete, or failed.
3. What useful result was produced most recently.
4. Which action is primary now.
5. How an interrupted operation reaches a definite outcome.

The product is not ready if a user must infer whether a spinner means model work, tool execution, transport loss, compaction, or a stale client projection.

## 3. Decisions that resolve existing document conflicts

### 3.1 State ownership

- Kernel `AgentState` owns agent execution semantics.
- Shared `deriveSessionState` owns cross-client presentation semantics derived from Kernel status and bounded transient inputs.
- Dashboard components consume one selected-session projection; Sidebar, Header, Composer, wake lock, title, and notifications do not independently reconstruct lifecycle rules.
- Connection health remains orthogonal to execution state.

### 3.2 PWA caching

The service worker caches the static app shell and content-addressed assets only. API requests, session history, Socket.IO, event streams, approvals, queues, and messages remain network-only. The read-only API runtime-cache proposal in the older PWA roadmap is superseded until authentication partitioning, host namespaces, staleness semantics, and deletion guarantees have a separate approved design [6].

### 3.3 Streaming

Packet batching and adaptive visual commits are allowed to reduce render cost, but already received assistant text must not be artificially delayed for decoration. There is one scheduler and one live-tail owner. Static empty-state typewriter effects remain separate from real model streaming [3][7].

### 3.4 Responsive surfaces

- Short, focused actions may use a Dialog.
- On mobile, suitable short dialogs may present through a shared bottom Sheet.
- Header and footer remain operable while the body owns scrolling.
- `visualViewport` and safe-area handling occur at shared surface boundaries, not through per-feature viewport guesses.
- Long-lived Settings, Operations, and Artifacts remain page-level workspaces where the existing information architecture specifies them. Evaluation uses its standalone Dashboard.

## 4. Delivery phases

Each phase is independently testable and deployable. A phase exits only after focused tests, affected package tests, typecheck, production build, relevant browser verification, screenshot evidence, and an updated implementation record.

### Phase 0 — Inventory, decisions, and baseline

Deliverables:

- Record existing principles and settle state, PWA cache, streaming, and responsive-surface conflicts.
- Establish current unit, browser, build, and performance baselines.
- Mark referenced plans as implemented, partial, proposed, or superseded rather than treating plans as shipped facts.

Baseline on 2026-07-28:

- Dashboard component/unit suite: 94 files, 703 tests passing.
- Existing mobile/PWA, layout, debugger, enhancement, Subagent, and real-dashboard scripts remain the browser evidence entry points.
- Current working tree contains ongoing reliability, rendering, PWA, compaction, Queue, Settings, and responsive changes; unrelated work must remain intact.

### Phase 1 — One lifecycle projection and definite recovery language

Scope:

- Derive selected-session activity once from the selected summary or matching hydrated live projection.
- Reuse it for Header, Sidebar override, title, wake lock, Composer gating, and intervention notifications.
- Preserve the boundary between execution activity and Socket.IO connection health.
- Add a pure state matrix covering session switching, loading transients, approval, errors, resting states, and stale-projection rejection.
- Add stable client operation identity to Queue/message acknowledgement in a later independent slice; do not combine it with the selector change.

Exit evidence:

- Switching A → B cannot show A's live state.
- Header and Sidebar collapse all running substates to the same stable animated indicator.
- Approval, failure, and reconnecting states do not masquerade as ordinary loading.
- Existing full Dashboard tests and activity browser checks pass.

### Phase 2 — Responsive surface primitives and core workflows

Scope, in order:

1. Reuse shared class contracts for mobile Sheet placement and touch close actions without changing DOM behavior.
2. Add a thin Dialog-based `SheetContent` only after Settings and Session Settings prove the repeated contract.
3. Align AlertDialog with visible-viewport and safe-area constraints.
4. Standardize fixed header/footer plus internally scrolling body.
5. Migrate Settings and Session Settings first, then Image Preview and app drawers.
6. Remove Composer fixed viewport offsets in favor of an actual anchor or measured CSS variable.
7. Complete Create Session, Queue attachments/editing, compaction continuation, and Subagent result/failure flows.

Required mobile matrix: 320×568, 375×667, 390×844 PWA, and 430×932. Every relevant surface verifies viewport containment, actual body scrolling, a minimum 44px touch target, Escape close, focus restoration, full/simple Composer, and no horizontal overflow. iOS keyboard and Home Indicator behavior retain a real-device release check because Chromium cannot reproduce them faithfully.

### Phase 3 — Reliability and rendering gates

Scope:

- Preserve Socket.IO delivery classes, stable operation IDs, ACK deadlines, reconnect redispatch, receipt fan-out, and absolute tool deadlines [5].
- Complete durable Executor receipt persistence before weakening any retry path.
- Add real process/network fault cases for duplicate ACK, Host/Executor loss, late result, cancellation, and restart recovery.
- Continue measured rendering work: receipt writer coalescing, token-delta batching, transcript incremental projection, deferred heavy renderers, and paint-cost cleanup [7][9].
- Turn representative performance scenarios from skipped diagnostics into budgeted gates.

Exit evidence:

- Every accepted mutation and tool call reaches completed, failed, cancelled, or explicitly uncertain; no permanent pending state.
- Duplicate delivery does not duplicate side effects.
- Session switching and token streaming remain within measured render budgets.

### Phase 4 — Trust, observability, and release governance

Scope, in order:

1. Make audit writes serialized, flushable, permission-constrained, and observable on failure.
2. Add role/workspace authorization and secure deployment defaults at the Host boundary.
3. Add low-cardinality runtime metrics for operation latency/outcome, reconnect, recovery, audit failure, Queue depth, and restart.
4. Add bounded asynchronous live OTLP export; keep transcript data redacted and do not block agent work on telemetry.
5. Strengthen restart markers, replacement readiness, versioned releases, and rollback.
6. Add release artifact attestations after readiness and rollback semantics are reliable.

Audit, RBAC, metrics, heartbeats, OTLP, and deployment state must not enter the Kernel reducer.

## 5. Verification policy

For each slice:

```bash
pnpm --filter <affected-package> exec vitest run <focused-tests>
pnpm --filter <affected-package> typecheck
pnpm --filter <affected-package> build
```

At integration boundaries:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm run verify:dashboard-layout-scroll
pnpm run verify:dashboard-mobile-pwa
pnpm run verify:dashboard-subagent-scroll
```

Run debugger, enhancement-action, real-provider, and tasks-button checks when their boundaries are touched. Browser checks use the production bundle and retain screenshots as evidence. A green HTTP probe is not visual verification.

## 6. Explicit non-goals

- No whole-site visual rewrite.
- No second session lifecycle state machine in Dashboard.
- No service-worker cache of authoritative runtime data.
- No fake typewriter over live assistant output.
- No tasks, audit, transport, telemetry, or release state in Kernel.
- No opaque general component framework before three proven consumers.
- No new `docs/capabilities/*.md` document.
- No claim that an entire phase is complete based only on documentation.

## 7. Implementation record

### 2026-07-28 — Phase 0

- Reviewed repository principles, past mistakes, testing policy, product polish, PWA, production readiness, Chat UX, rendering performance, Socket.IO reliability, and efficiency plans.
- Settled the four cross-document decisions in §3.
- Captured the Dashboard unit baseline: 94 files / 703 tests passing.

### 2026-07-28 — Phase 1 lifecycle slice

- Added one selected-session activity projection for wake lock, title, Sidebar override, and waiting-for-user notification gating.
- Added a pure matrix for stale session rejection, transient loading, approval, error priority, and message acceptance.
- Removed Subagent application-level Toast, Badge, and Push fan-out; child progress remains in the parent transcript/card.

### 2026-07-28 — Phase 2 responsive-surface slice

- Added shared mobile-sheet placement, touch-close, and internally scrolling body contracts used by Settings and Session Settings.
- Aligned AlertDialog with visible viewport and safe-area constraints.
- Dashboard suite: 96 files / 716 tests passing.
- Browser evidence passed: mobile/PWA 320/375/390/430 matrix, desktop/narrow layout matrix, and desktop/mobile Subagent matrix.
- Headless screenshots: `/tmp/agent-kernel-mobile-pwa-shots-e0xyfD`, `/tmp/agent-kernel-layout-shots-X21hiS`, and the paths emitted by the Subagent verification run.

### 2026-07-28 — Phase 3/4 reliability slices

- Replaced quadratic compaction preserve-boundary scans with one suffix-token/prefix-compactability index while preserving cut-point semantics.
- Serialized Executor receipt persistence, coalesced same-tick completions, fsynced file and directory, and delayed ACK fan-out until the receipt is durable.
- Batched Host token-delta Socket.IO packets per session over 16 ms and flushes before terminal/error/cancel events.
- Replaced fire-and-forget audit writes with an ordered managed logger supporting deterministic flush/close, `0600` files, and observable failure count.
- Restart state now uses temp-file fsync, atomic rename, and directory fsync.
- Full package results after these slices: Dashboard 716 tests, Host 781 passed / 2 skipped, Executor 161 tests; workspace typecheck passes.

### 2026-07-28 — Cross-page frontend maturity slice

- Replaced blank lazy-route fallbacks with an accessible loading surface and added Settings retry/loading/error semantics.
- Made Pipeline vertically scrollable on small screens, corrected its incomplete tab semantics, and expanded slide controls to touch-sized targets.
- Added Docs search labels, status/alert semantics, clear-search recovery, and mobile directory-to-reader navigation.
- Prevented Create Session cancellation while its durable ACK is pending; added Connect Workspace invite retry, clipboard failure feedback, and shell-safe release URLs.
- Added mobile segmented surfaces for Operations and Artifacts.
- Queue mutation controls are no longer exposed while the Session socket or Workspace is offline.
- Added `verify:dashboard-top-pages`: deterministic mobile/desktop screenshots for Operations, Artifacts, Pipeline, and Docs, horizontal-overflow checks, browser console/page-error failure, and visible-control accessible-name checks.
- Latest top-page evidence: `/tmp/agent-kernel-top-pages-wFWxHW`.

### 2026-07-28 — P1 frontend completion slice

- Queue reorder/update/delete now use awaited ACK RPCs with per-row busy state, visible failure, and retry; offline controls remain disabled.
- Queue updates carry structured content so text edits preserve attachments through the Host persistence boundary; summaries and mode labels are bilingual.
- Added a transcript append-only projection path that preserves historical item identity and falls back to full rebuild on history replacement, compaction merge, or session change.
- Added hard unit budgets: 5,000-entry full projection under 100 ms and a 100-entry append to a 5,000-item projection under 25 ms.
- Current verification: Dashboard 97 files / 720 tests, Host 98 files / 781 passed and 2 skipped; workspace typecheck/build, mobile/PWA matrix, and top-page browser matrix pass.

## References

[1] `docs/standards/engineering/principles.md`

[2] `docs/standards/release-quality/testing.md`

[3] `docs/research/proposals/frontend-modernization-plan.md`

[4] `docs/protocol/event-log.md`

[5] `docs/research/proposals/socketio-reliability-plan.md`

[6] `docs/planning/roadmap-notes/pwa-mobile-and-push.md`

[7] `docs/research/proposals/dashboard-rendering-performance-plan.md`


[9] `docs/archive/reviews/codebase-efficiency-review-2026-07.md`
