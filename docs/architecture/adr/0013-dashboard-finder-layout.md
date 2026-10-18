# ADR 0013: Dashboard Finder-style layout + control-plane events

**Status**: accepted
**Date**: 2026-07-04

## Context

The Dashboard needs to answer three questions the user has before opening a chat:

1. **Which machine am I about to run tools on?** Executors announce themselves; users should never type an IP:port into a text box to reach a machine.
2. **What sessions live on that machine, and what state are they in?** Session cards must be attributed to a daemon and expose OS, IP, and status so the user can pick before opening.
3. **What happened in this session before I refreshed?** Timeline history must survive a page reload — an Inspector that only shows events since this reload is a regression the moment a session runs for more than one visit.

Two open-source references informed the layout:

- **opencode** (`references/opencode/packages/app/src/`) — SolidJS + Kobalte + TanStack Solid Query. Sidebar rail with workspace→project→session hierarchy, HoverCard preview, session groups by Today/Yesterday/Older. Denser but assumes the user already knows which workspace they want.
- **Azure PR #879 `code-agent-hub`** (`references/azure-code-agent-hub-pr879/web-portal/public/index.html`) — vanilla ES-modules. Finder-style five-column drill-down: Login → Workspaces (daemons) → Agents → Sessions → Chat. Each column has its own header, spinner, and action button. Chat column has a `session-toolbar` with model / mode / usage-ring / working indicator, plus a `create-session-modal`, a `daemon-access-drawer`, and a `delegation-chip`.

The Finder pattern makes the daemon step *explicit* — the user has to see and pick a machine before they see sessions, which is the ergonomic property the user is asking for. It also naturally accommodates an empty "Agents" column today (agent-kernel has exactly one agent — the kernel itself) that will fill in when we add subagents.

## Decision

Adopt Azure PR #879's **five-column Finder layout** as the Dashboard's outer chrome, on top of React + Vite + TypeScript strict (see [ADR 0008](0008-dashboard-vite-react.md)), with shadcn primitives where they earn their keep and opencode's session-date-grouping.

Daemon and Executor are the same thing at the wire-protocol level — an executor is the machine that runs shell tools; a daemon is what the user calls that machine. We do not add a new abstraction.

### 1. Layout — five columns, Finder-style

```
┌──────────┬────────────┬──────────┬───────────────┬──────────────────────────┐
│  Login   │ Workspaces │  Agents  │   Sessions    │          Chat            │
│ (hidden) │ (daemons)  │  (fixed) │               │                          │
├──────────┼────────────┼──────────┼───────────────┼──────────────────────────┤
│          │            │          │ Sort ▸ Name   │ ┌ Session toolbar ─────┐ │
│  [skele- │ ● laptop-01│ ○ kernel │  Time  Agent  │ │ gpt-4o · plan · $.02 │ │
│   ton    │   linux·   │          │ ─ Today ─     │ └──────────────────────┘ │
│   for    │   .1.42 ●  │          │  • demo idle  │ ┌ Chat messages ───────┐ │
│   OAuth] │ ○ fly-01   │          │  • wip-fork ⑂ │ │ ...                  │ │
│          │   linux·   │          │ ─ Yesterday ─ │ │                      │ │
│          │   fly.io ○ │          │  • main       │ └──────────────────────┘ │
│          │            │          │               │ ┌ Approvals ───────────┐ │
│          │            │          │               │ │ [tool_call bash]     │ │
│          │            │          │               │ └──────────────────────┘ │
│          │            │          │ [+ Session]   │ ┌ Composer ────────────┐ │
│          │            │          │               │ │ > type here          │ │
│          │            │          │               │ └──────────────────────┘ │
│          │            │          │               │  [Inspector drawer, ⇔]  │
└──────────┴────────────┴──────────┴───────────────┴──────────────────────────┘
  0 px       ~240 px      ~160 px    ~280 px         fills, min 720 px
```

Column-by-column:

- **Login** — `display: none` today. The DOM skeleton stays in place (a single `<div id="col-login">` empty container in the JSX tree) so future OAuth / local-login work has an obvious insertion point.
- **Workspaces (daemons)** — one row per attached executor. Row shows `{ hostname, os icon, ip, health dot }`. Health dot: green if `connected`, grey if last-seen within 30 s but socket closed, red otherwise. Row click selects the daemon and drives the downstream columns.
- **Agents** — for now, a single fixed row: `kernel`. This column exists so the Finder metaphor is intact, and so that when subagents / planner / memory land (see [ADR 0005](0005-kernel-boundary.md)) they have a home. It is not collapsed — collapsing it would break the drill-down cadence — but it is narrow.
- **Sessions** — sessions belonging to the selected daemon, grouped by *Today / Yesterday / Older*. Group header sort pills (Name / Time / Agent — Agent is a placeholder for the future). Each row: title (or first-user-message excerpt), status pill (idle / thinking / awaiting_approval / executing_tools / done / error, mapped from `AgentState.status`), fork indicator `⑂` if `parentSessionId` present. "+ Session" button at the bottom opens Create Session Modal.
- **Chat** — the Chat + Approvals + Composer stack, prepended by a **session toolbar** row (`{ model · mode · usage ring · working indicator }`). `usage` and `status` come from `AgentState`; `model` is not tracked in state today (see §5, Deferred). Inspector is a **right-side resizable drawer**, default 400 px, collapsible via a toolbar button.

Modals (Radix `Dialog` — no shadcn CLI needed for a single component):

- **Create Session Modal** — inline daemon picker (radio group over attached executors) + working-directory input + optional title. On submit, Dashboard opens a new `useSession` connection to that `sessionId` via the standard socket-io handshake (`{ sessionId, role: 'dashboard', token? }`); Host's `SessionStore.ensure()` writes the JSONL header if it doesn't exist yet.
- **Daemon Details Drawer** — right drawer opened by clicking a daemon row's `⋯`; shows advertised tools, all IPs, uptime, runtime version, pid. No ACL yet — auth is `?token=` only.

Empty states are load-bearing here: "No daemons attached — start an executor with `pnpm --filter @agent-kernel/executor start`" tells a first-run user exactly what to do next, and "No sessions on this daemon — click + Session" tells them the same for step 2.

### 2. Concept map — daemon and executor

The user's language: **daemon** = the machine running the shell. In `packages/executor/src/client.ts`, the entity that dials the Host is called an **Executor**. They are the same thing:

| User-facing term | Code term | Wire-protocol term |
|---|---|---|
| daemon | executor | `executor:announce` |

Dashboard UI uses "Workspaces" as the column header (it reads better than "Daemons" to non-sysadmins) and shows daemon-shape data (hostname / os / ip) in each row. Docs continue to say "executor" when referring to the code entity and "daemon" when referring to the user-visible machine, cross-linked in the glossary section of `docs/protocol/wire-protocol.md`.

### 3. Wire-protocol additions

Four dashboard-facing events and one extended executor announce.

**`ExecutorAnnounce` — extended fields**

```ts
export type ExecutorAnnounce = {
  sessionId: string
  executorId: string
  tools: string[]
  workingDir?: string
  runtime: ExecutorRuntime
  runtimeVersion: string
  hostname?: string           // os.hostname()
  os?: 'linux' | 'darwin' | 'win32' | 'other'  // normalized os.platform()
  ipAddresses?: string[]      // non-loopback, non-link-local IPv4/IPv6 addresses
  pid?: number                // process.pid
  startedAt?: string          // ISO-8601, executor process boot time
}
```

The metadata fields are optional so an older executor connecting to a newer host still works; the Workspaces column shows whatever the executor advertises and falls back to `executorId` for the row label.

**Dashboard-side events**

```ts
// list currently-attached executors on this host
export type ClientListExecutors = { /* no body */ }
export type ServerExecutorsPayload = {
  executors: ReadonlyArray<ExecutorAnnounce & { attachedAt: string }>
}

// broadcast whenever an executor attaches / detaches / re-announces
export type ServerExecutorChangedPayload = {
  executorId: string
  change: 'attached' | 'detached' | 'updated'
  executor?: ExecutorAnnounce & { attachedAt: string }  // omitted for 'detached'
}

// list sessions on this host, with a per-session daemon attribution
export type ClientListSessions = { /* no body */ }
export type ServerSessionsPayload = {
  sessions: ReadonlyArray<{
    sessionId: string
    createdAt: string
    lastEventAt?: string
    eventCount: number
    parentSessionId?: string
    executorId?: string
    status?: AgentState['status']
    firstUserMessage?: string
  }>
}

// on connect, fetch the full timeline so refresh doesn't lose events
export type ClientLoadHistory = {
  sessionId: string
  sinceCursor?: number   // if omitted, return the full log
}
export type ServerHistoryPayload = {
  sessionId: string
  entries: ReadonlyArray<EventAppendedEvent>
}
```

Socket.IO event names (dashboard namespace only):

```ts
// client → server
'client:list_executors'
'client:list_sessions'
'client:load_history'
// server → client
'server:executors'
'server:executor_changed'
'server:sessions'
'server:history'
```

`docs/protocol/wire-protocol.md` covers all four in the "Control-plane events" section, matched 1:1 to the types above.

### 4. Timeline history load

On dashboard connect (`useSession` mount), after `session:ready` lands:

1. Emit `client:load_history { sessionId }`.
2. Host reads `sessionsDir/<sessionId>.jsonl` via `readSessionLog()` in `packages/host/src/store/log.ts`.
3. Host maps event lines → `EventAppendedEvent[]` and returns them in `server:history`.
4. Dashboard merges the historical entries into `timeline` state before any subsequent `event:appended` starts appending. Merge is a straight append; dedup by `seq` in case a race delivers a live event that overlaps the tail of history.

Refresh preserves timeline. Jumping into an old session from the Sessions column immediately shows what happened, not just what happens next.

### 5. Frontend stack

React + Vite + TypeScript strict (see [ADR 0008](0008-dashboard-vite-react.md)).

| Concern | Choice |
|---|---|
| Routing | Plain URL query params. The Finder columns are stateful UI, not routes — a session change updates a search-param, not the pathname. |
| Server state | Ad-hoc `useEffect` + emit/on for the three list events. The surface is small (three endpoints); a query cache would not earn its bundle-size cost. |
| Primitives | Radix `Dialog` directly for the Create Session modal + Daemon Details drawer. Additional shadcn primitives (DropdownMenu, HoverCard, etc.) get pulled in one at a time when needed. |
| Icons | `lucide-react` — one icon set, tree-shakeable, small. |
| Dates | `date-fns` — only for Today/Yesterday grouping. |

Net dependency additions vs the pre-redesign dashboard: `@radix-ui/react-dialog`, `lucide-react`, `date-fns`. All three are single-purpose and small (~30 KB gzipped combined), well under the 350 KB budget from ADR 0008.

### 6. Test coverage

Component tests in vitest + testing-library. What each test file covers:

- **Workspaces column** — renders one row per announced executor, health-dot color driven by attached/detached state, os-icon + ip + hostname visible, empty state text.
- **Sessions column** — group headers (Today/Yesterday/Older), sort pills, session-row status pill mapped from `AgentState.status`, fork indicator visibility when `parentSessionId` is set, empty state.
- **Create Session Modal** — daemon radio-group selection, submit opens a session (assert the socket handshake `auth.sessionId` matches the intended id), cancel closes the modal.
- **`useSession` history load** — emits `client:load_history` on `session:ready`, appends historical entries to `timeline` before any subsequent `event:appended`, dedups by `seq` when a live event overlaps the tail.

E2E: one test opens the dashboard against a live host + executor, reloads the page, and asserts the timeline still shows the pre-reload events. Also asserts daemon-row presence and session-row status pill.

## Alternatives considered

**A. Opencode-style rail + workspace/project hierarchy.**

*Rejected.* opencode's rail assumes the user already knows which workspace they want and is switching *inside* it. Our users are more often deciding *which machine to run against* — the daemon step is not incidental, it's the main navigational decision. Making it a rail hover-card demotes it. TanStack Router + Query would also be new tooling in the repo for state that fits comfortably in `useState`.

**B. Hybrid: opencode rail + a Daemons drawer.**

*Rejected.* Two entry points to the same information (rail row *and* drawer) doubles the surface area without adding clarity. The Finder pattern collapses the two into one: the daemon column *is* the drawer, always visible.

**C. Two-column layout with a "Sessions" pane above ChatPanel and a "Daemons" pane inside Inspector.**

*Rejected.* On a 1440-px display, chat gets ~700 px after subtracting Inspector (400) + Sessions (240) + Daemons (240); typography goes wrong below 640 px. The Finder layout keeps Chat at the far right where it dominates.

**D. Azure's full stack (vanilla ES modules, no framework).**

*Rejected.* Forcing every contributor to learn hand-rolled state modules is a higher tax than sticking with React. We borrow the *layout* and the *interaction model* (columns as drill-down, session-toolbar as in-session controls); we do not borrow the transport or state management.

**E. Manage sessions / daemons via CLI only, keep the Dashboard chat-focused.**

*Rejected.* Switching sessions is high-frequency in replay/fork demos, which are the product's differentiator. A terminal round-trip in the marquee flow is a regression.

## Consequences

**Good**:

- Daemon selection stops being an IP+port text box. First-run users see attached machines and click to pick.
- Session cards attribute themselves to a daemon and expose OS / IP / status — the metadata is visible before opening the session, not after.
- Timeline persists across refresh. The Inspector is a "since session start" view, not a "since this reload" view.
- Sub-agents / planner (see [ADR 0005](0005-kernel-boundary.md)) have a home when they land — the Agents column is intentionally kept even though it holds only one row today.
- No new router, no new query cache. The dashboard stays small enough that a new contributor can read the whole `app.tsx` in one sitting.
- ADR 0008's bundle-size argument continues to hold: `date-fns` + `lucide-react` + `@radix-ui/react-dialog` are the only additions.

**Bad**:

- Five columns don't fit comfortably below ~1200 px. A `≤ 900 px` collapse rule folds Workspaces and Agents behind a hamburger; only the currently-selected daemon + agent appear as breadcrumbs above the Sessions column. The full-width behavior is what the user actually asked for; the narrow-screen fallback is at least usable.
- `ExecutorAnnounce` grows five optional fields. Older executors omit them; the Workspaces column falls back to `executorId`. Not a break, but a "why is this row missing an OS icon?" cognitive step for the reader.
- `readSessionLog` runs on every dashboard connect. `readFile` + `JSON.parse` per line; for a session with thousands of events, that's a few ms and one syscall. Mitigation if it ever shows as a hotspot: `client:load_history` accepts `sinceCursor` so returning-visitor dashboards fetch only the tail, and the response can be chunked over multiple `server:history` frames.

**Deferred**:

- Multi-Host awareness. Today the Dashboard talks to exactly one Host (config's `host` URL). Adding a Hosts column outside the Workspaces column is possible but out of scope — most users run one Host locally.
- Session search / full-text over messages.
- Model / mode picker in the session toolbar. `AgentConfig` doesn't carry a model field today, and there's no model registry to enumerate. The toolbar shows a static "model: —" label until that lands.
- Real-time cursor / presence, cross-agent-call delegation-chip, session ACLs.
