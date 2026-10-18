# Dashboard Browser Feature Todo

Modern browser features we can adopt without increasing agent core state-machine or wire-protocol complexity.

## Priority 1

- **CSS Container Queries**: make Inspector, LLM API modal, Composer, and tool-call rows adapt to their actual container width instead of global viewport breakpoints.
- **View Transitions API**: smooth dashboard-only transitions for session switching, debugger tab changes, and detail modal entry/exit. Use progressive enhancement only.
- **Web Workers**: move heavy derived debugger work off the main thread, especially JSON stringify/search, diff hunk building, message composition estimates, and trace filtering.
- **Clipboard API**: add explicit copy actions for redacted API request/response, tool input/result, message assembler summary, and compact debug bundles.
- **Popover API / CSS `:has()`**: use native/lightweight UI state for small local affordances such as context pressure details, row actions, and error-tone parent styling.
- **Performance API**: add local-only dashboard diagnostics for modal open cost, JSON render cost, transcript render cost, and long-task detection.

## Priority 2

- **Scroll-Driven Animations**: add subtle scroll progress and sticky-shadow feedback in Trace, JSON, LLM request/response, and transcript panels.
- **BroadcastChannel**: sync dashboard-local preferences across tabs, such as theme, selected session hinting, and command palette recents. Do not sync runtime state.
- **File System Access API**: export/import local trace/debug bundles and redacted LLM request/response JSON when available.
- **OffscreenCanvas**: reserve for future high-density trace minimap, LLM/tool waterfall, or context composition heatmap rendering.

## Acceptance Constraints

- No UI-only fields in `@agent-kernel/kernel` or `@agent-kernel/shared`.
- No new core reducer state solely for visuals.
- No protocol additions unless they represent real runtime semantics.
- Every feature must degrade cleanly on unsupported browsers and old logs.
- Expensive derived work must be cancellable or isolated from the main interaction path.
