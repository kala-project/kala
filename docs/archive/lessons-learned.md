# Known past mistakes

A list of engineering mistakes that have been made in this repository, kept as a checklist to consult before starting new work. See [principles.md](../standards/engineering/principles.md) for the rules distilled from these mistakes.

---

## 1. Exposing implementation detail as user-facing information

- **Symptom**: an early version of the SWE-bench wizard rendered absolute paths at every step (`plan → <absolute-path>/.../worker-plan.json`, `patches → /...`, `predictions → /...`).
- **Root cause**: developers default to thinking of paths as the way to reason about outputs; from the user's perspective paths are noise and outputs are semantic summaries such as "12 tasks ready" or "7/12 resolved".
- **Lesson**: for every piece of UI copy, first answer "what is the user trying to do at this step"; any field that is not in the answer must not appear in the main view. Paths, `instance_id`, JSONL filenames, and artifact hashes go inside `<details>` by default. See principles.md A1.

## 2. Bundling short one-shot actions with long-lived workspaces in one dialog

- **Symptom**: `ArtifactExplorerDialog` combined Eval, Ops, Profiles, Memory, and Artifacts — each a long-lived workflow — into a single modal.
- **Root cause**: the reasoning was "they all browse artifacts, so share one dialog"; but a benchmark run has lifecycle state, history, outputs, and failure post-mortems, which is a page-level workspace.
- **Lesson**: the rule for modal vs page is "will the user stay here for several minutes, compare multiple objects, or return later?" If any answer is yes, it must be a page; only if all three are no does a modal apply. See principles.md C1.

## 3. Blurring "prediction" and "result" in copy

- **Symptom**: after the Infer step completed, the UI said "X predictions completed", leading users to assume X were resolved, when in fact resolution requires running the official Docker harness.
- **Root cause**: internal vocabulary treats "prediction" and "result" as interchangeable; user-facing language reads "completed" as "succeeded".
- **Lesson**: `resolved` may only appear after the official score has been imported. Enforce this in lint and test assertions. Similar semantic boundaries: `patch generated` ≠ `patch applies`; `test executed` ≠ `test passes`. See principles.md A3.

## 4. Presenting an internal name as a user-facing default that does not run

- **Symptom**: the Infer step's Agent Recipe default was labelled "executor", but `kala-executor` is a Socket.IO daemon with no `run` subcommand, so choosing the default failed 5/5 times.
- **Root cause**: an internal component name was surfaced as a user-facing option, and no end-to-end verification confirmed the default path worked.
- **Lesson**: every default UI option must be exercised in CI or e2e and must succeed. Default names must answer "what does this choice do", not name a component. A correct example: "Smoke-test recipe (empty patch — verifies pipeline only)". See principles.md B2.

## 5. Fake end-to-end tests using HTTP probes instead of a headless browser

- **Symptom**: `verify-wizard-grade-and-labels.mjs` originally POSTed and inspected response bodies for clean paths; but when a real user opened the browser, React's `_valueTracker` prevented inputs from taking effect, so frontend state was always empty and the flow was broken.
- **Root cause**: HTTP probes verify backend contracts, not "can the user actually click through". Controlled components, `_valueTracker`, tab-switch render timing, and post-`setState` DOM staleness are only reachable through a real headless-browser run.
- **Lesson**: UI-related verification must click through with puppeteer or playwright; HTTP-only "equivalent proofs" are not accepted. See principles.md B1.

## 6. Premature abstraction in the name of "elegance"

- **Symptom**: `enhancement-cli.ts`, `enhancement-export.ts`, and `enhancement-foundation.ts` were extracted as a generic enhancement mechanism early; but each concrete feature had different logic, and the shared abstraction became a liability. All three were later deleted in favour of feature-named modules.
- **Root cause**: a shared interface was extracted before three concrete implementations existed — purely from imagination.
- **Lesson**: write the concrete implementation first; extract a shared interface only when the third similar case appears. "Three similar lines is better than a premature abstraction" — already in CLAUDE.md, not previously followed. See principles.md D2.

## 7. Treating progress visibility as a nice-to-have

- **Symptom**: the Infer step ran for five minutes with no UI feedback; users assumed the page had frozen and refreshed repeatedly.
- **Root cause**: the backend wrote progress to `progress.json` but the frontend did not read it, on the theory that "backend having it is enough".
- **Lesson**: any operation longer than 3 seconds must have UI progress feedback, and that feedback must include "what is being processed now / total count / completed count". A `progress.json` file the user cannot see does not count as progress. See principles.md B4.

## 8. Assuming an English-only default for a bilingual audience

- **Symptom**: early copy was English-only; the dashboard opened as a wall of English technical jargon, which was jarring for Chinese-language users.
- **Root cause**: the default assumption was "this is for developers, English suffices".
- **Lesson**: i18n applies from day one; `en` and `zh` are updated together. A PR that adds a new UI string in a single language is not merged. See principles.md A4.

## 9. "Big-bang" commits after long stretches without committing

- **Symptom**: one session began with 81 uncommitted files after several prior sessions accumulated changes. Splitting the changes into commits after the fact meant many "why" fields had to be reconstructed from memory.
- **Root cause**: a habit of not committing until a feature is "fully working", trying to line up a "complete" state before committing, and viewing intermediate-state commits as history pollution.
- **Lesson**: commit each independently reviewable change as it lands. Do not wait for "perfect" or "complete". Intermediate-state commits are fine — commit density and granularity are part of engineering rhythm. See principles.md D1.

## 10. Design documents outnumbering code

- **Symptom**: `docs/capabilities/` reached twelve design documents. On first opening the repo, if the `docs/` tree is larger than `packages/`, the impression is "planning without shipping".
- **Root cause**: treating "planning" as "output"; writing design documents has an immediate psychological reward, whereas writing code has a delayed one.
- **Lesson**: every capability document must correspond to at least one shipped feature commit. Capability documents older than two weeks with no corresponding code are deleted or downgraded to issues. No new `docs/capabilities/*.md`. See principles.md E1, F4.

## 11. Forgetting who the product is for

- **Symptom**: the early dashboard homepage was full of internal terms (enhancement action, artifact kind, subagent policy metadata). These names are reasonable in code and obstacles in the UI.
- **Root cause**: the same person writes the UI and the backend and mentally shares too much context between them.
- **Lesson**: for every user-facing string, re-read it as a reader with no prior context; anything unclear should be rewritten. See principles.md A5.

---

*Append a new entry whenever a new mistake occurs. Rules distilled from these entries become hard constraints in principles.md.*
