# agent-kernel design and implementation principles

These are hard constraints. Any new PR that violates one of them is considered incomplete and must be revised before merging. Each principle maps to at least one lint, test, or e2e enforcement so it can be checked mechanically.

Read before starting work; self-check after writing; use this as a review checklist.

---

## A. User-facing surface

### A1. Fully hide implementation paths

Server absolute paths, artifact hashes, JSONL filenames, and raw `instance_id` strings must not appear in the main dashboard UI. They may only appear inside an explicit `<details>` "Show technical details" fold.

**Enforcement**:

- `packages/dashboard/scripts/verify-visual-pages.mjs` scans each page's main-body DOM: matches for `/\/home\//`, `/\/tmp\//`, `/\.kala/`, `/\.jsonl\b/` cause a failure.
- The only allowed exceptions are the Artifacts page Raw JSON viewer and content inside an explicit `<details>` element.

### A2. User language, not component names

UI copy must answer "what is the user trying to do at this step", not "which internal component is being invoked".

**Enforcement**: locale structure tests keep English and Chinese resources in
sync, and focused component/browser tests assert user-visible labels rather than
internal component names. Standalone evaluation vocabulary is tested in the
standalone Dashboard, not the product Dashboard.

### A3. Distinct vocabulary per state transition

Each layer of state transition must use its own vocabulary; do not reuse a term from a higher layer:

- `prediction ready` is distinct from `patch applies`, `tests passed`, and `resolved`.
- Only SWE-bench uses `resolved`. Terminal-Bench uses `resolved/unresolved` but must annotate the source parser. WebArena uses `score`. Tau-bench uses `reward`.
- `resolved` may only appear after Import Results has completed.

**Enforcement**: standalone adapter and Dashboard tests assert benchmark-specific
result semantics. The product Dashboard has no benchmark state machine or
evaluation terminology.

### A4. English and Chinese kept in sync

Every new UI string must be added in both `en` and `zh` locale resources.

**Enforcement**: a structure test in `resources.ts` asserts that the `en` and `zh` key sets are exactly equal; a single-language PR fails CI.

### A5. Readable by a first-time reader

After writing UI copy, re-read it as a reader with no prior context. If a phrase is not self-explanatory, rewrite it.

**Enforcement**: no automation; enforced during review against the rename table in D.3.

---

## B. Ground truth

### B1. UI changes must be exercised by a headless browser

Any PR that touches the dashboard must be exercised by Puppeteer or Playwright and produce a screenshot. HTTP probes, unit tests, and typechecks are not equivalent evidence.

**Enforcement**: production browser acceptance must exercise the current product routes and include its evidence artifact in the release record.

### B2. Default choices must be exercised end-to-end

Every default value in the UI must be exercised in CI or an e2e run and must succeed. A default that breaks the primary flow is unacceptable.

**Enforcement**: every wizard or form default recipe must be exercised in e2e. Default names must answer "what does this choice do", not name an internal component.

### B3. No mock fallbacks

"Mock now, real implementation later" is not accepted. A feature either runs for real or does not ship.

**Enforcement**: occurrences of `mock`, `fake`, `stub`, or `TODO: replace with real` in new code must document why and must be confined to test paths. Production paths containing them fail review.

### B4. Progress visibility

Any operation longer than 3 seconds must have UI progress feedback that includes three elements: what is being processed now, total count, and completed count. A `progress.json` file that the frontend does not read does not count.

**Enforcement**: e2e coverage of "click Run -> within 3s a progress element appears in the page"; every long-running backend task has a `progress.json` and a corresponding frontend hook.

---

## C. Product shape

### C1. Modal vs page

If a user will spend more than a few minutes, compare multiple objects, or return later, any one of those means it must be a page, not a modal. Only when all three are false is a modal appropriate.

**Enforcement**: any new dialog PR must answer these three questions in its description; violations get reverted.

### C2. Three-section StepCard

Every step's output panel must follow an `Input / Action / Output` structure. Technical detail goes inside a `<details>` fold.

**Enforcement**: `StepCard.tsx` is the only entry point; bypassing it is prohibited. A structure test asserts every StepCard has three sections.

### C3. Visual consistency

No card-in-card. No native scrollbars. No long explanatory prose inside the main workflow area; fold it or move it to a tooltip.

**Enforcement**: `verify-visual-pages.mjs` takes screenshots for comparison; native scrollbars are detected via computed style.

### C4. Sticky header and deep-link

Every page must have a sticky header. Every major page state must be deep-linkable so a refresh returns the user to the same run, artifact, or executor.

**Enforcement**: page-level e2e that exercises "load hash directly -> restore the correct state".

### C5. Accessibility and responsive design

- Icon-only actions must have a tooltip or aria-label.
- Primary navigation must have both an icon and a text label.
- Layout: 3-column at 1024+; 2-column at 768-1023; Inspector becomes a drawer below 768.

**Enforcement**: Playwright screenshots cover desktop and mobile viewports; an aria-label lint runs on the DOM.

---

## D. Engineering cadence

### D1. Small, frequent commits

Commit each independently reviewable change as it lands. Intermediate-state commits are fine; do not wait for "complete" or "perfect" batches.

**Enforcement**: each agent task defaults to committing on completion; a session must not end with more than 20 uncommitted files.

### D2. No premature abstraction

Write the concrete implementation first. Extract a shared interface only after a third similar case appears.

**Enforcement**: any PR named "generic" or "framework" must list three concrete consumers; otherwise it is rejected.

### D3. No unneeded error handling

Validate only at system boundaries: user input and external APIs. Trust framework guarantees internally. Defensive fallbacks, feature flags, and backwards-compatibility shims are prohibited unless a boundary contract explicitly requires them.

### D4. No "what" comments

Comments describe non-obvious "why": hidden constraints, subtle invariants, workarounds, and surprising behavior. A comment such as `// increment i` should be deleted on review.

**Enforcement**: enforced during review.

### D5. Cross-cutting capabilities do not enter the core state machine

Authentication, audit, notifications, hooks, internal RPC, benchmark operations, and similar cross-cutting concerns must live at the host boundary or in an extension layer. They must not pollute the kernel reducer or the core state machine, which expresses agent execution semantics only. Observation, accountability, UI controls, and external side effects belong in independent modules that subscribe to or wrap the kernel.

**Enforcement**: any new `AgentEvent` variant or reducer branch must document why it is agent transcript semantics rather than a host or control-plane event.

### D6. Executor performs environment adaptation only

The executor wire protocol does not carry `kernel`, `direct`, or `internal` mode. The executor executes `tool:call` and returns the result. Whether that result enters the message list, session JSONL, audit log, or dashboard RPC response is a host decision.

**Enforcement**: `ToolCallMessage` must not contain fields such as `dispatchMode` or `directMode`; executor code must not branch on the transcript destination of a tool result.

### D7. Audit log and session JSONL have distinct roles

The session JSONL is the agent execution trace and replay log. The audit log is a control-plane accountability log. The audit log records actor, action, target, outcome, summary metadata, and reference IDs such as `sessionId`, `sessionSeq`, `callId`, and artifact URIs. It does not duplicate full LLM bodies, full user messages, or full tool outputs.

**Enforcement**: when introducing an audit event, check whether a session JSONL source of truth already exists; reference it rather than copying the payload.

### D8. Document reference format

Design documents use paper-style `[1]`, `[2]` numbered references in the body. Full URLs live in a `## References` section at the end. External source references use commit-hash GitHub permalinks; avoid local `references/...` paths or floating branch links.

**Enforcement**: bare inline URLs and local reference paths as citation sources are rejected on review.

---

## E. Documentation discipline

### E1. No new `docs/capabilities/*.md`

Twelve capability documents is the ceiling. Additional design ideas go under `docs/planning/roadmap-notes/` or straight into an issue.

### E2. Every design document must bind to at least one shipped commit hash

A capability document with no corresponding code after two weeks is deleted or downgraded to an issue.

**Enforcement**: `scripts/verify-doc-code-binding.mjs` should scan the frontmatter of each `docs/capabilities/*.md` for a `commit:` field.

---

## F. Non-goals

- **F1** No standalone sandbox executor abstraction layer.
- **F2** No pure-infrastructure direction such as HDFS, Kubernetes, or MQ. This project is a product plus evaluation platform; infrastructure work does not belong here.
- **F3** No mock-first implementations or placeholder stubs.
- **F4** No new `docs/capabilities/*.md`.
- **F5** No OSWorld-class desktop or computer-use benchmarks. They are not in the first benchmark set and are too GUI/VM-heavy for the executor plus browser plus tool-protocol path.

---

## G. Memory and external dependencies

### G1. `MEMORY.md` is an index only

Each entry is a single line no longer than 150 characters; the substantive content lives in a separate memory file.

### G2. Web search uses Serper when freshness is required

When a fresh web search is needed, use the configured Serper API rather than relying on stale local knowledge.

---

## Appendix: review checklist

Before merging a PR:

- [ ] Main-body DOM contains no server paths, `instance_id`, or JSONL filenames (A1)
- [ ] Copy uses user language, not component names (A2)
- [ ] `resolved` appears only for the correct benchmark at the correct stage (A3)
- [ ] `en` and `zh` updated together (A4)
- [ ] UI changes include a headless-browser screenshot (B1)
- [ ] Default choices are exercised in e2e (B2)
- [ ] No `mock`, `fake`, or `TODO-replace` on the production path (B3)
- [ ] Operations longer than 3 seconds have frontend progress feedback (B4)
- [ ] Dialog vs page decision is justified (C1)
- [ ] StepCard structure is three-section (C2)
- [ ] No card-in-card, no native scrollbar (C3)
- [ ] Sticky header and deep-link (C4)
- [ ] Accessibility and responsive coverage (C5)
- [ ] Independent small commit (D1)
- [ ] No premature abstraction (D2)
- [ ] No defensive code (D3)
- [ ] No "what" comments (D4)
- [ ] No new `docs/capabilities/*.md` (E1, F4)
