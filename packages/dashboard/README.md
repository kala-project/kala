# @agent-kernel/dashboard

The **visualization layer**. A React SPA that subscribes to a Host session over Socket.IO and renders chat + a live state inspector + a replay/fork UI. Served by Host from `packages/dashboard/dist/` — no separate deploy required.

---

## Stack

- **Vite** + **React 18** + **TypeScript strict**
- **Tailwind CSS** with shadcn semantic tokens (`--background` / `--card` / `--sidebar` layered surfaces, light + dark themes via `darkMode: 'class'`)
- **Radix primitives** (`@radix-ui/react-dialog`) for modals and drawers
- **`lucide-react`** for icons
- **`date-fns`** for Today / Yesterday / Older session grouping
- **socket.io-client** for wire
- **Vitest** + **@testing-library/react** for component tests

Not Next.js (see [ADR 0008](../../docs/architecture/adr/0008-dashboard-vite-react.md)). This is a static SPA — no SSR, no server components. Ships as a `dist/` you can host anywhere (Cloudflare Pages, Vercel static, GitHub Pages, or the Host process serving `/`).

## Layout

Five-column Finder-style shell (see [ADR 0013](../../docs/architecture/adr/0013-dashboard-finder-layout.md)): Login (hidden) → Workspaces (daemons) → Agents → Sessions → Chat, with the Inspector as a right-side resizable drawer.

## Feature areas

- **Explorer** (`src/features/explorer/`) — workspace + session tree with time-bucket grouping, cwd surfacing, rename-in-place, Info dialogs for workspace and session metadata.
- **Chat panel** (`src/features/chat/`) — message list (text + image blocks, streaming render, compact boundary marker, user message edit + fork, image paste), Composer (model picker, context pressure ring, approval mode picker, `/compact` slash command, context pressure banner).
- **Inspector** (`src/features/inspector/`)
  - **State tree** — live JSON view of `AgentState`
  - **Timeline** — ordered event list with cursor labels; click an event to inspect it
  - **Effects** — per-event effect list (`call_llm`, `call_tool`, `persist`, `emit_progress`, `finish`)
  - **Usage** — running token totals
  - **Approvals** — cards with unified diff for `edit` / `write` tool calls
- **History** (`src/features/history/`) — timeline scrubber + Fork button on every event; lineage bar links back to the parent session.
- **Settings** (`src/features/settings/`) — provider list (auto-imported + user-added), model picker per provider, Azure Speech voice input, approval mode default, host / port config.
- **Create Session** (`src/features/create-session/`) — workspace picker + Finder-style cwd picker + provider/model picker.
- **Background terminal** (`src/features/background/`) — panel derived from `bash` / `bash_output` / `kill_shell` events.
- **Activity bar** (`src/features/activity/`) — bottom bar: runtime status, permission banners.

## App identity

The original octopus mark shares one vector source in `src/brand/octopus.ts`.
Web/PWA uses coral; desktop uses mint with a small dock underline. Generate all
favicon, install, maskable, notification and native PNG assets with
`pnpm --dir packages/host exec tsx ../../scripts/dashboard/generate-app-icons.mjs`
from the repository root. New icon URLs avoid reusing cached pre-octopus assets;
legacy asset paths remain compatible. No third-party illustration is bundled.

## Interface sizing

Settings > Interface controls the whole application size (75-200%, default
125%) and individual chat, session-list, file-list and file-view font sizes
(10-48 logical pixels). Sliders, numeric input and per-control reset are
available; tool-activity icons support 100-300%. Individual font sizes are
multiplied by the interface scale. Existing saved font selections keep their
meaning.

Use rem-based typography and dimensions for interface chrome, including small
labels. Pixel-based renderers such as virtualized trees, Monaco and terminals
must apply `useInterfaceScale()` and update their layout without recreating a
session or PTY. The app shell and Settings navigation choose their responsive
layout using the scaled breakpoints in `useMinWidth()`. Do not implement this
with CSS `zoom`, which leaves viewport units and media queries inconsistent.

## Serving security policy

The Host does not add a global Content-Security-Policy to the static dashboard. Deployments that set CSP at a reverse proxy must permit `blob:` in both `media-src` (MP4 previews) and `frame-src` (sandboxed PDF previews), while keeping `object-src 'none'`. Scope those directives to the product dashboard; the separate evaluation dashboard does not use this feature and must not inherit them. The desktop shell carries the equivalent policy in `src-tauri/tauri.conf.json`.

## What it does NOT do

- Call the LLM directly — always goes through Host.
- Persist sessions — Host owns the JSONL log; the dashboard is a viewer.
- Modify kernel state — every user action is a Socket.IO event dispatched to Host.

## References

- Wire protocol: [`docs/protocol/wire-protocol.md`](../../docs/protocol/wire-protocol.md) §3.2
- Architecture: [`docs/architecture/overview.md`](../../docs/architecture/overview.md)
- **Visual style rules**: [`STYLE.md`](STYLE.md) — surface/border conventions, dark-mode do's-and-don'ts. **Read this before adding any `border-*` class.**

## Test coverage

Component tests use `@testing-library/react` with a mocked Socket.IO client, asserting user-visible behavior. Target per [`docs/standards/release-quality/testing.md`](../../docs/standards/release-quality/testing.md) §5.

**Caveat**: mocked-socket tests do **not** prove the app connects, renders, or accepts input against a real Host. For any UI-shipping change that touches the initial connection, first paint, or theming, verify against a real browser (headless is fine) hitting the Host-served bundle — see the "verify frontend with real browser" convention.

`pnpm --dir packages/host exec tsx ../../scripts/dashboard/verify-dashboard-session-connection.mjs`
(from the repository root) exercises hover-preview → selection, resync and reconnect
for workspace-free Kernel and Copilot sessions on an isolated Host. It records
visible/hidden idle CPU profiles and browser-process CPU ticks under `.artifacts/`.
`CONNECTION_DASHBOARD_DIST` selects an alternate production build. Its native bridge
fixture verifies frontend behavior, not GTK/WebKit resource consumption.

Session readiness requires a fresh `session:ready` baseline for the current
selection, even if a preview already owns the shared room. **Resync** requests that
baseline and then reloads Kernel history; it does not restart the Host.
Pending connections retain their breathing indicator; Thinking retains the
breathing dot, sheen and live elapsed/progress label. Session-busy and
history-loading icons rotate continuously, with reduced-motion preferences
respected. Do not use removed effects or stepped animation as a performance
optimization. Native CPU evidence must identify the actual rendering backend:
Xvfb with Mesa llvmpipe measures software rendering, not a user's GPU.
