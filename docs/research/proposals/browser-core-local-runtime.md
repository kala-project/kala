# Browser-Core Local Runtime

**Status**: Design note. Planned runtime option, not current implementation.

This document evaluates a local teaching mode where the agent core runs in the browser and talks directly to a local tool executor. It does not replace the v1 Host topology described in [ARCHITECTURE.md](../../architecture/overview.md). The goal is to make the reducer, state transitions, LLM message assembly, approval gates, and tool lifecycle easier to inspect while preserving a clean security boundary for workspace effects.

---

## Current topology

The current v1 runtime is:

```text
Dashboard (browser) <-> Host (Node.js) <-> Executor (Node.js)
                         |
                         +-> LLM provider
```

This shape is still the right default for hosted and production-like use:

- Host owns session state, event log replay, kernel execution, LLM provider adapters, and dashboard broadcasts.
- Executor owns workspace-local tools and dials out to Host.
- Dashboard renders the teaching/debugging surface but does not execute the agent core.

The tradeoff is that the most instructive internals are observed through Host broadcasts rather than by colocating the runtime with the UI.

---

## Proposed teaching topology

For a local teaching mode, the browser can own the agent core while a local executor exposes a localhost tool API:

```text
Dashboard + Agent Core (browser)
        |
        | WebSocket / HTTP on localhost
        v
Tool Executor (Node.js, opens a local port)
        |
        +-> workspace tools
```

The durable responsibility split should be:

```text
Browser owns reasoning, state, replay, and debugger views.
Executor owns workspace effects and path/cwd enforcement.
Optional thin LLM proxy owns secrets and provider adapters.
```

This is not a relay removal for v1. It is a separate runtime mode optimized for local education and inspection.

---

## Runtime modes

### 1. `host`

Current behavior.

```text
Dashboard -> Host -> Executor
Dashboard -> Host -> LLM provider
```

Use when:

- a shared Host should own sessions and persistence
- LLM secrets must stay server-side
- executors may be remote from the browser
- the dashboard should remain a static client

### 2. `browser-local`

Browser owns the core loop and talks to a local executor plus a user-provided LLM endpoint.

```text
Dashboard + BrowserRuntime -> Local Executor
Dashboard + BrowserRuntime -> User/local LLM endpoint
```

Use when:

- the user is running everything on one machine
- direct LLM access is acceptable for a local demo
- maximum inspectability matters more than production deployment shape

Limitations:

- direct provider calls often hit CORS restrictions
- browser-held API keys are visible to the page runtime
- provider-specific streaming and request signing may not work uniformly

### 3. `browser-local-proxy`

Browser owns the core loop and uses a minimal local LLM proxy for secrets/provider adapters.

```text
Dashboard + BrowserRuntime -> Local Executor
Dashboard + BrowserRuntime -> Thin LLM Proxy -> LLM provider
```

Use when:

- the teaching UI should still show the full core state machine
- provider credentials must not live in browser storage
- raw request/response capture and redaction should remain centralized
- CORS/provider differences should be normalized locally

This is the recommended browser-core mode for real local usage.

---

## Browser responsibilities

In browser-local modes, the browser can own:

- kernel reducer execution and host loop orchestration
- message queue editing and dispatch order
- debugger trace and state-flow visualization
- event log storage in IndexedDB
- replay, fork, and step-through execution
- approval prompts and approval decisions
- LLM request assembly visualization before each provider call
- runtime settings that are safe for client-side storage

This makes the teaching surface first-class. A learner can see exactly which event entered the reducer, which effects were produced, why the next LLM request contains each message, and how a tool result changes state.

---

## Executor responsibilities

The executor must remain the only component that performs workspace effects:

- filesystem reads/writes/edits
- shell execution and background shell lifecycle
- grep/glob/list operations
- cwd validation and normalization
- sandbox root enforcement
- tool schema publication
- cancellation of in-flight tool calls
- optional local config discovery for models and workspace metadata

The browser is not trusted for arbitrary paths. Every tool request still carries a requested cwd/path, and the executor validates it against sandbox roots before doing work.

---

## Optional LLM proxy responsibilities

A thin local LLM proxy should own:

- API keys and provider credentials
- provider-specific request signing and headers
- model registry import from local tools such as Codex or Claude Code
- raw request/response capture
- redaction before any payload is shown in the dashboard
- consistent streaming envelopes for the browser runtime

The proxy should be intentionally smaller than the current Host. It should not own the reducer, session state machine, tool routing, or workspace effects.

---

## Security constraints

Localhost does not remove the security boundary.

- The executor must bind to `127.0.0.1` by default, not `0.0.0.0`.
- Startup must generate a capability token and require it on every request.
- The executor must check `Origin` and reject unexpected browser origins.
- CORS should allow only the configured dashboard origin.
- Sandbox roots and cwd validation remain mandatory.
- Destructive tools must keep the existing approval semantics.
- Tool requests from the browser are untrusted input.
- Direct browser-to-provider LLM calls must be treated as a local-only convenience because API keys are exposed to the page runtime.

---

## Teaching value

The motivation is not just fewer processes. The value is that the concepts being taught become visible at the place where the learner interacts:

- reducer input event
- previous state and next state
- emitted effects
- pending tool calls and approval gates
- exact LLM request body before dispatch
- raw or redacted LLM response body after dispatch
- message queue mutations
- replay/fork boundaries
- cwd and sandbox checks before tool execution

This turns the UI into a debugger for the agent runtime rather than a remote monitor of a hidden server loop.

---

## Proposed evolution

The clean path is to introduce runtime interfaces before moving behavior:

1. Add an `AgentRuntime` interface with explicit dependencies:
   - `eventStore`
   - `llmClient`
   - `toolTransport`
   - `sessionStore`
   - `settingsStore`
2. Implement the current Host as `NodeHostRuntime` without changing behavior.
3. Add `BrowserRuntime` using IndexedDB, browser-safe settings, and local transports.
4. Add executor serving mode, for example `kala-executor --serve-tools --port 0`.
5. Add a dashboard runtime selector with `host`, `browser-local`, and `browser-local-proxy` options.

Each step should keep the contracts small enough that tests can run the same reducer scenarios against both runtimes.

---

## Non-goals

- Do not remove Host from v1.
- Do not make the browser responsible for filesystem or shell execution.
- Do not bypass cwd/sandbox validation because the executor is local.
- Do not put provider secrets in browser storage for the recommended local mode.
- Do not add a second full Host under a different name; the proxy, if used, should stay narrow.
