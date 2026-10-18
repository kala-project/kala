# Testing Strategy

**Status**: Normative for what testing looks like at each layer.

**Tooling**: Vitest [1] for package tests; Puppeteer/Chromium and deployment scripts for browser and system acceptance.

**Deployment contract**: [`../architecture/deployment-mode-contract.md`](../../architecture/deployment-mode-contract.md)

The testing strategy tracks the architecture: pure-function Kernel → integration-tested Host → contract-tested Executor → Gateway/identity/Unit isolation → real-browser and full-system acceptance.

Two rules apply together and neither replaces the other:

1. **Push defect localization as low as possible.** A unit test is the fastest way to pinpoint an invariant failure.
2. **Prove every critical user journey at its real product boundary.** Unit, component, mock, fixture, and protocol tests supplement this proof; they never substitute for it.

The full-system standard is defined by the [Product E2E Harness Contract](../../development/testing/product-e2e-harness.md) and tracked per journey in the [Critical User Action Acceptance Matrix](../../development/testing/critical-user-action-matrix.md).

---

## 1. Layered testing pyramid

```
                       ┌──────────────────┐
                       │   e2e (journeys)   │  ← one real proof per critical journey
                       └──────────────────┘
                     ┌──────────────────────┐
                     │  integration (host)   │  ← medium
                     └──────────────────────┘
                   ┌──────────────────────────┐
                   │  contract (executor tools) │  ← fast
                   └──────────────────────────┘
                 ┌──────────────────────────────┐
                 │   unit (kernel — pure)         │  ← fastest, most
                 └──────────────────────────────┘
```

Approximate implementation share (not an acceptance quota):
- Kernel: 100% unit
- Host: 70% unit + 30% integration (mocked LLM & socket)
- Executor: 80% unit + 20% integration (real fs, tmpdir)
- Dashboard: component tests plus targeted Puppeteer verification scripts for real browser/layout checks
- Private Cloud Gateway and Unit routing: identity/session and two-Unit integration tests
- Full system: mode-specific task-chain acceptance for the critical action matrix

Passing a percentage target cannot compensate for a missing critical-journey proof.

---

## 2. Kernel — pure unit tests

**Location**: `packages/kernel/src/**/*.test.ts`
**Runner**: `pnpm --filter @agent-kernel/kernel test`
**Coverage target**: 100% (achievable because there's zero IO)

### 2.1 What to test

Every case in [SPEC.md](../../reference/kernel/spec.md) §3 (legal event × status pairs). For each:
- Positive case: legal transition, correct next state, correct effects
- Negative case: no-op behavior (cursor advances, state otherwise unchanged, effects empty)

### 2.2 Invariant tests

For each invariant in SPEC §5, one test that would fail if the invariant broke:
- I1 cursor monotonicity: `expect(step(s, e, c).next.cursor).toBe(s.cursor + 1)`
- I2 purity: `JSON.parse(JSON.stringify(s0))` before and after step, deep-equal check
- I5 status ↔ pendingCalls consistency: for each status, assert pending call shapes

### 2.3 Property tests (optional but recommended)

Use `fast-check` for:
- Randomly sequenced events never crash / throw
- `fold(s0, events, c)` equals iteratively applying `step`
- `fork(s0, evs, cursor, alt, c)` equals `fold(s0, evs.slice(0, cursor).concat(alt), c)`

Kept optional because they're hard to debug when they fail. Add when they earn their keep.

### 2.4 Non-tests (deliberately absent)

- **No mocks.** Kernel has no dependencies.
- **No async tests.** Kernel is synchronous by construction.
- **No file/network fixtures.** Kernel does no IO.

If a kernel test needs any of the above, the kernel has grown IO and violated [ADR 0001](../../architecture/adr/0001-pure-reducer.md).

### 2.5 Current state

The Kernel suite is discovered from `packages/kernel/src/**/*.test.ts`; avoid hard-coded test counts because they become stale. See the test files for concrete examples.

---

## 3. Host — integration with mocked LLM and socket

**Location**: `packages/host/src/**/*.test.ts`
**Runner**: `pnpm --filter @agent-kernel/host test`
**Coverage target**: ≥80%

### 3.1 LLM adapter tests

Mock the HTTP client (undici / fetch), not the adapter. Verify:
- Anthropic Messages API request shape (system prompt / user / assistant / tool_use / tool_result mapping)
- Response parsing: text blocks → `TextContent`, `tool_use` blocks → `ToolCallContent`
- Usage extraction: `usage.input_tokens` / `usage.output_tokens` → `UsageDelta`
- Error mapping: HTTP 429 → `llm_error` event with rate-limit message; HTTP 5xx → generic; network abort → cancellable

Fixtures: real recorded response bodies (or hand-crafted minimal ones). Store in `packages/host/src/llm/__fixtures__/`.

### 3.2 Host loop tests

The host loop consumes effects, does IO, feeds events back to `step`. Test it with a mock LLM (returns a canned response) and a mock Executor (returns a canned tool result):

```ts
const mockLlm = { call: vi.fn().mockResolvedValueOnce(cannedResponse) }
const mockExecutor = { callTool: vi.fn().mockResolvedValueOnce({ ok: true, content: 'hi' }) }
const final = await runSession(initial, config, { llm: mockLlm, executor: mockExecutor })
expect(final.status).toBe('done')
```

Verify:
- Turn terminates on `finish` effect
- `llm_error` event → `error` status
- Tool call errors are swallowed as `tool_result(ok=false)` and the loop continues
- Cancellation is honored mid-loop

### 3.3 Event log tests

Given a sequence of `step` calls, the JSONL log should:
- Start with a `header` entry
- Contain one `event` entry per step
- Round-trip: `loadSession(path)` returns the same final state as the live loop had

### 3.4 Wire protocol tests

Spin up the Socket.IO server on a random port. Use `socket.io-client` to simulate a dashboard and an executor. Drive a full turn and assert:
- Handshake auth is validated
- `state:changed` is emitted after each event
- `tool:call` reaches the executor
- Executor ACK is translated into a `tool_result` event

**Don't test Socket.IO itself** — trust it.

---

## 4. Executor — contract tests per tool

**Location**: `packages/executor/src/tools/**/*.test.ts`
**Runner**: `pnpm --filter @agent-kernel/executor test`
**Coverage target**: ≥90%

Every tool listed in [tools.md](../../reference/executor/tools.md) has a test file with:
- **Happy path**: valid input → success, output shape matches spec
- **Missing file**: → `ENOENT: ...`
- **Permission denied**: chmod 000, or path outside workspace → `EACCES: ...`
- **Invalid schema**: missing required field → schema validation error
- **Idempotency** (for `write` / `edit`): running the same call twice produces the same file contents
- **Edge cases** specific to the tool (e.g. `edit` with `replace_all: false` on ambiguous match → `EAMBIG`)

### 4.1 Fixtures

Use `tmp` package or `fs.mkdtemp()` to isolate each test's filesystem. Clean up in `afterEach`.

### 4.2 Bash tool

Extra tricky. Tests should cover:
- Command succeeds → stdout captured
- Command fails (exit code ≠ 0) → `ok: true`, exit code in trailer
- Command times out → killed, `killed after Nms` marker
- Interactive commands (stdin) → executor MUST NOT wait for stdin. Feed `/dev/null`. Test that commands trying to read stdin don't hang.
- `cwd` outside workspace → `EACCES`

### 4.3 Sandbox tests

Not a tool per se, but the workspace whitelist enforcement:
- Path with `..` traversal → normalized, checked
- Symlink pointing outside workspace → detected, rejected
- Absolute paths outside → rejected
- Relative paths inside → resolved, allowed

---

## 5. Dashboard — component + e2e

**Location**: `packages/dashboard/src/**/*.test.tsx` / `*.test.ts` (component and pure view-model tests), `scripts/dashboard/verify-dashboard-*.mjs` (Puppeteer real-browser checks)
**Runner**: `pnpm --filter @agent-kernel/dashboard test` for component/unit tests; root `verify:*` scripts for targeted browser checks.

### 5.1 Component tests

For each React component, test the visible behavior given props:
- ChatPanel: renders assistant messages, tool call cards, approval buttons
- StateTree: renders a JSON tree, toggling nodes works
- Timeline: renders event list, clicking an event highlights it

Use `@testing-library/react`. Snapshot tests are permitted but should assert user-visible content, not DOM structure.

### 5.2 Browser verification scripts (Puppeteer)

The checked-in browser scripts are intentionally narrow and production-shaped:

- `pnpm run verify:dashboard-debugger`: debugger tabs, trace teaching mode, LLM API detail modal, runtime state/tools, theme contrast screenshots.
- `pnpm run verify:dashboard-layout-scroll`: responsive layout, drawer sizing, controlled scroll surfaces, modal sizing, screenshot coverage.
- `pnpm run verify:dashboard-subagent-scroll`: nested sub-agent transcript layout and virtual scroller width.
- Legacy Task List compatibility is covered by the dashboard timeline parser and tool-summary renderer tests; current planning E2E coverage uses `todo_graph`.
- `pnpm run verify:dashboard-real`: full real-host / real-executor / real-provider smoke. This is the broadest and slowest check.

The default browser automation stack is `puppeteer-core` against a local Chrome/Chromium. Scripts that need real LLM output must say so in their header and should stay out of routine fast CI unless credentials and cost policy are explicit.

### 5.3 Real-browser cross-check for UI changes

Component tests (React Testing Library + jsdom) verify contract, not visual behavior. **Any UI change — theme, layout, dashboard bundle — MUST be cross-checked in a real headless Chromium before shipping.** The concrete rule that came out of the OKLCH dark-mode regression:

1. Rebuild the dashboard (`pnpm --filter dashboard build`) and restart Host — the dashboard is served from `packages/dashboard/dist/`, not the vite dev server, so unbuilt `.tsx` edits will not appear at `:3000`.
2. Attach to Chrome with remote debugging (`--remote-debugging-port=9222`) and connect via `puppeteer-core`.
3. Load `http://localhost:3000`, toggle each theme the change touches, and read `getComputedStyle(document.body).backgroundColor` (and text color of the primary panels). Fail the check if the computed color falls outside the expected range for that theme — a "white screen in dark mode" bug can pass every jsdom test because jsdom doesn't compute CSS.
4. Verify the fetched CSS bundle is served with `Cache-Control: no-cache` (or a filename hash) — otherwise old CSS keeps loading even after a rebuild and the check appears to pass on a stale bundle.

Browser acceptance must use Chromium pointer/keyboard input for user actions.
DOM-dispatched `element.click()` calls bypass hit-testing and can hide blocked,
covered, or inert controls. Product E2E uses the pointer-safe helpers in
`scripts/product-e2e/harness.mjs`; `pnpm run test:product-e2e-harness` enforces
this rule in the release journey scripts.

The rule is stricter than jsdom/component coverage because these checks run against the production-shape bundle that end users see.

---

## 6. Full-system E2E (critical user journeys)

A full-system E2E is a task chain, not a component render or a collection of endpoint probes. Except for an explicitly documented external-capability boundary, it must use:

1. the production build or release artifact users receive;
2. the real user entry in Chromium when the journey has UI;
3. real HTTP and Socket.IO transports;
4. real Host and Executor processes;
5. real persistence and filesystem/process/service side effects;
6. an isolated OS environment when the feature mutates OS state;
7. the final user-visible state and the authoritative backend state;
8. reload, reconnect, or restart proof for durable behavior;
9. failure/retry and cleanup proof where applicable.

The public Internet, a production public domain, third-party identity provider, paid model provider, push delivery network, and unavailable physical device are valid external-capability boundaries. A test may replace only that boundary with a controlled implementation using the same public protocol. It must label the substitution and cannot claim compatibility with the omitted external provider or device.

Examples:

- Add Workspace does not pass when `/install` and its assets return `200`; it passes when a command copied from the production Dashboard installs in a clean Linux system, starts the service, connects the Executor, displays the Workspace, survives restart, rejects replay, and cleans up.
- Terminal does not pass when a component emits `terminal:input`; it passes when real Chromium keyboard input crosses Host and Executor, reaches a real PTY, produces visible output, resizes, closes, and cleans up after reconnect.
- PWA update does not pass from source-code pattern checks; it passes when an old production service worker controls a page, a new build is deployed, update/reload completes, and the active Session remains usable.

The required journey set is the Critical User Action Acceptance Matrix, not one representative golden path.

---

## 7. Test data conventions

### 7.1 Fixtures

- **LLM response fixtures**: `packages/host/src/llm/__fixtures__/<provider>/<scenario>.json`
- **Tool test fixtures**: `packages/executor/src/tools/__fixtures__/<tool>/<case>/*`
- **JSONL log fixtures**: `packages/host/src/store/__fixtures__/*.jsonl`

### 7.2 Naming

- Test files: `<subject>.test.ts` sit next to `<subject>.ts`
- Full-system E2E: `verify-<journey>.mjs` under `scripts/product-e2e/`; focused browser checks keep the `scripts/dashboard/verify-*.mjs` naming
- Fixtures: descriptive filenames, not `test-1.json`

### 7.3 Isolation

Each test file is a hermetic unit — no shared mutable state, no test-order dependencies. System E2E uses unique ports, HOME/data roots, browser profiles, Sessions, Workspaces, and LXD instances, and verifies their deletion.

### 7.4 Truthful labels

- `unit`: no process/network boundary.
- `component`: rendered component with substituted dependencies.
- `integration`: two or more real product modules, possibly with a controlled boundary.
- `browser-check`: real browser but not necessarily a complete task chain.
- `system-e2e`: production artifact plus complete real task chain under the rules in §6.
- `external-canary`: includes a public provider/domain/device outside the hermetic product boundary.

Test names, comments, reports, and release notes must use these labels. A fixture-driven browser check must not be reported as a system E2E.

---

## 8. CI

The repository CI workflow is the executable source for current jobs. Required release evidence is broader than fast PR CI and has these lanes:

1. package typecheck, build, and unit/integration tests;
2. release-asset and Compose security/config validation;
3. Portable production-bundle and Dedicated systemd browser acceptance;
4. Private Cloud Gateway/identity/two-Unit isolation acceptance;
5. mode-specific critical user task chains and screenshots;
6. real provider and real-device checks when affected.

Each critical-action row must link to an executable system-E2E scenario or carry an explicit gap/owner. Fast CI may omit slow system lanes, but release acceptance may not turn an omitted lane into a pass.

If browser or Private Cloud lanes are not automated in the current GitHub workflow, they remain mandatory release evidence and must be reported as manual—not described as an existing CI job.

### 8.1 Test time budgets

- Kernel: entire suite < 1s
- Host: < 30s
- Executor: < 20s
- Dashboard component: < 15s
- Focused browser scenario: < 5 min
- Full Portable/Dedicated/Private Cloud release acceptance: separate long-running lane with explicit timeout per task; system verification must not use a blanket 120-second ceiling

If a suite blows through its budget, the PR should split slow tests out into a dedicated slow-tests job or profile and optimize.

---

## 9. What tests you don't need

Some tests are tempting but low-value:

- **Testing Socket.IO's own routing**. Trust the library.
- **Testing `fs.readFile`**. Trust Node.
- **Testing that TypeScript catches type errors**. That's what `tsc --noEmit` in CI is for.
- **100% branch coverage on the LLM adapter's error mapping**. The important paths (429, 500, network) are enough; testing every 4xx is not.
- **Snapshot tests of generated HTML**. If you can, prefer semantic queries (`getByRole`, `getByText`).

---

## 10. Debugging tests

- Kernel tests are pure — if they fail, run one in isolation with `pnpm test -- -t "test name"` and inspect the state / effect diff
- Host integration tests: use `DEBUG=socket.io*` env var for wire visibility; use `--reporter=verbose` for step-by-step logs
- Browser verification: rerun the relevant Puppeteer script with `CHROME_PATH` / `DASHBOARD_URL` / `HOST_URL` pointed at the failing environment; do not stare at CI-only output

## References

[1] https://vitest.dev/
