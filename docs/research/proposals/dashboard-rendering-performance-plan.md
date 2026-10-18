# Dashboard Rendering Performance Plan

## Objective

Improve dashboard responsiveness during token streaming, tool-heavy turns, long transcripts, and rapid session switching without changing session semantics or losing scroll/UI state.

The work is split into independently testable stages. Each stage must pass targeted unit tests, dashboard type-check/build, the full dashboard test suite, and the relevant headless-browser checks before the next stage is accepted.

## Baseline invariants

- Every live event is scoped by both `sessionId` and connection generation.
- A previous session projection must never appear in the newly selected session.
- Running-state indicators remain stable across `thinking`/`executing_tools` flips.
- Completed transcript rows retain stable keys and object identity.
- Streaming updates affect only the live tail and visible transcript range.
- Session switches preserve each session's pinned/scroll state.
- Reduced-motion preferences remain respected for decorative transitions.
- Heavy renderers do not block initial chat/session-switch paint.

## Stage 1 — Session-scoped runtime subscriptions and Explorer isolation

Introduce a small `useSyncExternalStore`-based runtime store keyed by session ID. Session rows subscribe to their own runtime snapshot rather than receiving a whole status map through the Explorer root. Structural tree data remains separate from volatile status/cwd/activity data.

Acceptance:

- Updating session A does not render session B's row.
- Runtime payloads cannot cross session IDs.
- Selection changes only affect old/new selected rows.
- Existing grouping, rename, drag, hide, and hover-preview behavior remains intact.

## Stage 2 — High-frequency render boundaries

Move high-frequency live-tail subscription/rendering below the workbench/app shell boundary. Keep completed transcript data, Explorer, toolbar, dialogs, and composer independent of token-frame commits. Component extraction alone is insufficient; subscription ownership must move with the boundary.

Acceptance:

- Streaming-tail updates do not rebuild Explorer/tree data.
- Completed transcript rows remain memoized.
- Toolbar state changes only when coarse selected-session activity changes.

## Stage 3 — Adaptive streaming scheduler

Replace unconditional frame-rate commits with a scheduler that:

- targets roughly 30 fps under normal load;
- reduces to roughly 15 fps on costly/large-backlog paths;
- increases chunk size instead of commit frequency while catching up;
- buffers without visual commits while the document is hidden;
- flushes promptly when visibility returns;
- cancels all scheduled work on session switch/unmount.

Acceptance:

- Ordering and final text are exact.
- No stale buffered text crosses a session generation.
- Hidden-page buffering does not create a replay storm.
- Scheduler behavior is covered with deterministic fake-clock tests.

## Stage 4 — Transcript virtualization and per-session scroll state

Strengthen Virtuoso boundaries:

- stable item keys derived from event/message identity;
- completed rows and live tail use separate identities;
- visible-range rendering does not invalidate completed rows;
- pinned state and scroll location are stored per session;
- height-changing renderers notify Virtuoso through supported measurement paths.

Acceptance:

- Switching A → B → A restores A's scroll/pinned state.
- History merge/optimistic inserts do not remount unrelated rows.
- Follow-output remains correct when pinned and does not jump when unpinned.

## Stage 5 — Deferred heavy rendering

Lazy-load and defer optional expensive features such as Mermaid, Monaco, Shiki language/theme work, large diffs, and artifact views. Use visibility-triggered rendering for off-screen heavy blocks and idle scheduling for non-interactive preprocessing. Use workers only for measured, serializable CPU-heavy transforms.

Acceptance:

- Initial chat bundle does not eagerly execute optional heavy renderers.
- Off-screen content has a stable placeholder and renders when near viewport.
- Copy/download/plain-text behavior works before enhancement completes.
- Deferred failures degrade to a readable fallback.

## Stage 6 — Explorer update granularity

Keep workspace/session structure memoized independently from volatile runtime metadata. Rows receive stable scalar structural props and subscribe to volatile data themselves. Use one shared low-frequency clock for relative times rather than per-row timers.

Acceptance:

- Runtime status updates do not rebuild workspace grouping.
- Relative-time refresh does not affect transcript/workbench.
- Tree operations and virtualization remain stable.

## Stage 7 — Compositing and paint-cost cleanup

Audit `will-change`, `translateZ`, `backdrop-filter`, box-shadow animations, and large motion surfaces. Keep compositor hints only on small active transform/opacity animations. Avoid promoting every card/row and reduce large-area blur where it provides little value.

Acceptance:

- Status spinner owns a single transform animation without competing transform declarations.
- No row-wide permanent `will-change` promotion.
- Reduced-motion behavior remains correct.
- Headless computed-style checks verify critical animation declarations.

## Verification matrix

After every stage:

```bash
pnpm --filter @agent-kernel/dashboard exec vitest run <targeted tests>
pnpm --filter @agent-kernel/dashboard typecheck
pnpm --filter @agent-kernel/dashboard build
```

At major integration boundaries and before deployment:

```bash
pnpm --filter @agent-kernel/dashboard test
pnpm --filter @agent-kernel/dashboard verify:real
pnpm --filter @agent-kernel/dashboard verify:layout-scroll
pnpm --filter @agent-kernel/dashboard verify:mobile-pwa
pnpm --filter @agent-kernel/dashboard verify:subagent-scroll
pnpm --filter @agent-kernel/dashboard exec vitest run src/features/chat/tasks-from-timeline.test.ts src/features/chat/toolSummaries/renderers.test.ts
```

Additional focused scripts are selected when their feature is touched: `verify-column-resize.mjs`, `verify-model-switch.mjs`, `verify-session-label.mjs`, `verify-folder-picker-depth.mjs`, `verify-timeline-expand.mjs`, and `verify-tool-call.mjs`.

## Deployment

Build release assets, atomically install them in the `agent-runlab-host` LXC container, and request `/runtime/restart` with checkpoint mode. Because deployment runs from a session hosted by that same process, restart dispatch must be asynchronous; completion is verified after reconnection by attempt ID, PID change, service status, dashboard HTTP response, and deployed asset checksum.
