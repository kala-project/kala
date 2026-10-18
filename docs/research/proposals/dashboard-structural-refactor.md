# Dashboard structural refactor plan

Large `features/*` files have grown into "god files" that mix many components +
pure helpers in one module, making them hard to read, review, and unit-test. This
is a **pure structural refactor**: move code into well-named modules, add missing
unit tests for the extracted pure logic, and guarantee **zero behavior change /
no regression**.

## Non-negotiable safety rules (apply to EVERY step)

1. **One feature per commit.** Never mix two features in one commit.
2. **Move, don't rewrite.** Extractions are cut/paste + import wiring. No logic
   edits in the same commit as a move. If a real fix is needed, it is a separate
   follow-up commit.
3. **Public behavior preserved.** The externally-imported symbols keep working;
   add re-exports (or update every importer) so nothing outside the module
   breaks.
4. **Verify each step before moving on:**
   - `pnpm -C packages/dashboard run typecheck` clean, AND
   - the feature's existing test file(s) pass, AND
   - any tests touching the moved symbols pass.
5. **Add tests for newly-isolated pure logic** (functions that were previously
   un-testable because they were buried). New tests must pass.
6. **Precise naming** (the `text-reveal` lesson): module/dir names must describe
   the concern and not be generic (`internals`, `shared`, `utils` are banned as
   final names).
7. If a step turns risky/ambiguous, stop and report rather than guess.

## Baseline (measured)

| File | lines | defs | dir files | plan |
|---|---|---|---|---|
| artifacts/shared/internals.tsx | 3590 | 15 exports (many big views) | god file behind thin re-export views | split per view + rename away from `internals` |
| app.tsx | 2934 | App ~2100 lines + ~30 pure helpers | top-level | extract pure helpers + hooks into `app/` |
| inspector/InspectorPanel.tsx | 2961 | 58 comps | 4 | split panels/sections |
| settings/SettingsDialog.tsx | 2875 | 33 comps (clean Section split) | 2 | one file per Section (safest; do FIRST) |
| explorer/Explorer.tsx | 1575 | 15 | 16 (already partly split) | extract remaining helpers |
| chat/ChatPanel.tsx | 3287 | 39 | 47 (best-split already) | extract remaining pure helpers last |

## Execution order (safest → highest-value, incremental)

Ordered so the first step is the most mechanical/low-risk and establishes the
pattern, and each later step benefits from the momentum.

### Phase 1 — settings/ (mechanical, lowest risk; the pattern template)
- Create `settings/sections/`. Move each `*Section` component to its own file
  (`RuntimeSection.tsx`, `InterfaceSection.tsx`, …).
- Move shared controls (`Toggle`, `InterfaceToggle`, `SectionHeader`,
  `SettingsSectionButton`, number/segmented fields) to `settings/controls/`.
- `SettingsDialog.tsx` keeps only the `SECTIONS` registry + layout + routing.
- Tests: existing `SettingsDialog.test.tsx` must still pass; add focused tests
  for any pure helper extracted (e.g. section resolution).

### Phase 2 — artifacts/ (rename god file, split per view)
- Split `shared/internals.tsx` so each view's real implementation lives with its
  public wrapper: fold `EvalRunsViewInternal` into `EvalRunsView.tsx`, etc.
- Extract the pure artifact helpers (`isOpsArtifactKind`, `opsKindOrder`,
  `asRecord`, `evalRunRoot`, `groupTrialArtifacts`, `mergeEvalRuns`,
  `trialStableId`, `trialInstanceId`) into `artifacts/model.ts` (pure, testable).
- Delete `internals.tsx` (banned name) once emptied.
- Tests: existing artifacts tests pass; ADD unit tests for the pure model
  helpers (currently untested).

### Phase 3 — inspector/ (split 58 components)
- Group the 58 components by concern into `inspector/panels/*` +
  `inspector/rows/*`; keep pure model logic in the existing `debugger-model.ts`.
- `InspectorPanel.tsx` keeps the shell + tab routing.
- Tests: existing `InspectorPanel.test.tsx` + `debugger-model.test.ts` pass; add
  tests for any newly-isolated pure helper.

### Phase 4 — app.tsx (highest value)
- Create `app/` and extract the ~30 pure helpers by theme:
  `app/compaction.ts` (`hasCompactableContent`, `isCompactTerminalEvent`,
  `isCompactionSuccess`, `compactFailureMessage`, `compactReasonMessage`),
  `app/session-activity.ts` (`sessionActivityStatus`,
  `isRunningSessionActivity`, `coarseStatusForIndicator`,
  `isWaitingForUserInput`), `app/optimistic-queue.ts`
  (`mergeOptimisticQueuedMessages`, `reconcileOptimisticQueuedMessages`,
  `queuedMessageKey`), `app/session-selectors.ts` (`sessionExists`,
  `sessionDisplayLabel`, `sessionIdsForCacheInvalidation`, `removedSessionIds`).
- Extract cohesive hooks (`useModels`, `useMinWidth`, `useIsMobile`, models
  helpers) into `app/hooks.ts`.
- `app.tsx` keeps the `App` component (state orchestration + JSX) only.
- Tests: existing app tests pass; ADD unit tests for each extracted pure module
  (these were previously buried and untested).

### Phase 5 — explorer/ + chat/ (trim remaining helpers)
- Explorer: extract remaining pure helpers into `explorer/model.ts`.
- Chat: extract remaining pure helpers from `ChatPanel.tsx` (e.g. markdown block
  split, cursor-target detection) into `chat/markdown/` with tests.

## Definition of done (whole effort)

- Every phase committed separately, each with typecheck + tests green.
- No `internals`/`shared`/`utils`-as-final-name modules remain among the touched
  files.
- Net new unit tests cover the pure logic that was previously untestable.
- A final full `pnpm -C packages/dashboard test` run is green, and the perf
  regression suite still passes (no rendering regression).
