# Dashboard Frontend Modernization Plan

> Scope: `packages/dashboard`<br>
> Status: Phases 1-4 implemented on 2026-07-11<br>
> Author: collaborative planning note, 2026-07-11

## 1. Background and Goals

`packages/dashboard` is a Vite + React 18 single-page application. It subscribes to `packages/host` through Socket.IO and also uses HTTP routes from `packages/host/src/http/routes.ts`. The stack is already mature: Radix UI, Tailwind, shadcn-style local components, `class-variance-authority`, `tailwind-merge`, `cmdk`, `sonner`, and `lucide-react`.

The dashboard is primarily an observability and development workbench. Information density, professional feel, and scan efficiency are always more important than decorative polish. That does not mean the UI should feel unfinished. In low-frequency atmospheric moments, restrained polish is allowed when it improves perceived quality without hiding operational signals.

Core principle: keep the work surface quiet, but do not let it feel bare.

Goals:

1. Move scattered `useState + fetch + useEffect` request handling into a mature data layer to reduce races and boilerplate.
2. Make list insertion, deletion, and local layout changes smoother at low implementation cost.
3. Add typewriter or micro-motion only in places where atmosphere matters more than rapid scanning.
4. Define where product polish is allowed, so future work avoids both overuse and a total ban.

## 2. Adoption Plan

### Phase 1: Auto-Animate Pilot

Goal: validate whether zero-config DOM animation fits the project's interaction style.

Dependency: `@formkit/auto-animate`.

Candidate surfaces, starting with only two or three:

- `features/chat/TasksButton` expanded task list.
- `features/chat/BackgroundTerminalPanel` shell list.
- Expanded tool-call groups inside `features/chat/ChatPanel`.
- Optional fallback: `features/artifacts/ArtifactExplorerDialog` file list.

Explicitly avoid:

- Message append itself, because socket streaming should show real arrival rhythm.
- `react-virtuoso` or `react-arborist` internals, because they manage DOM reuse.
- `sonner` toasts, because they already have built-in animation.

Acceptance criteria:

- Users perceive smoother local transitions.
- No frame drops.
- Bundle growth remains small.
- Reduced-motion users get an appropriate fallback.

### Phase 2: TanStack Query for HTTP Reads

Goal: move request/response HTTP calls to TanStack Query for caching, race handling, refetch control, and optimistic update support.

Dependencies: `@tanstack/react-query` plus dev-only devtools if useful.

Boundary principles:

- Use Query for one-shot, cacheable HTTP resources with clear keys:
  - `ServerModelsPayload`.
  - `FileListResult` and `FileContentsResult`.
  - Product artifact and Session profile lists.
  - Docs tree and document content.
  - Overflow and memory-consolidation result queries.
- Do not move Socket.IO event streams into Query:
  - Keep `session.ts`, `state-flow.ts`, `useSession`, and `useControlPlane` as the event model.
  - Query owns REST-style data; sockets own event data.
  - Socket handlers may use `queryClient.setQueryData`, invalidation, or refetch when bridging is needed.

Migration strategy:

1. Start with one page, preferably `ArtifactsPage`, and establish provider, loading, and error conventions.
2. Migrate page by page so each change is reviewable and revertible.
3. Do not refactor sockets into Query.

Acceptance criteria:

- Target pages replace `useState + useEffect + fetch` with `useQuery` or `useMutation`.
- Weak network and tab-switch scenarios no longer flash empty data unnecessarily.
- Devtools or logs show no duplicate request churn.

### Phase 3: Motion on Critical Paths

Goal: use Motion only where it improves a critical transition, not as a blanket animation layer.

Dependency: `motion`.

Candidate surfaces:

- `features/chat/ComposerFlipContainer`, if Motion can simplify the existing flip without losing behavior.
- Dialog or sheet entry/exit only if a mature Radix + Motion pattern is warranted.
- `features/chat/ContextPressureBanner` breathing or warning emphasis with low-amplitude opacity/scale.

Explicitly avoid:

- Ordinary hover or press interactions, where Tailwind transitions are enough.
- List insertion and deletion, which belongs to auto-animate.
- Typewriter behavior, which should be a small local hook.

Acceptance criteria:

- Critical transition code becomes simpler or meaningfully clearer.
- Animation quality does not regress.
- No layout shift or CLS regression.

### Phase 4: Typewriter and Caret

Goal: use a typewriter effect only for static, known, one-time copy where atmosphere is more important than scan speed.

Implementation: no library. A small hook using `useEffect`, timers, and substring output is sufficient. Reduced-motion should return full text immediately.

Candidate surfaces:

- New-session empty-state welcome copy in `ChatPanel`.
- `CommandPalette` placeholder or hint copy.
- `ArtifactsPage` empty state.
- First-connection guidance in `features/explorer/ConnectWorkspaceDialog`.
- `ErrorBoundary` fallback copy.
- Optional future docs landing slogan.

Caret: show a blinking caret before completion, remove it after completion unless explicitly configured otherwise. Implement with CSS keyframes.

Anti-patterns:

- Do not add typewriter behavior to assistant streaming messages; they are already real streams and animation would misrepresent model speed.
- Do not animate session titles, timestamps, inspector JSON, toasts, or any repeated scan surface.
- Do not use typewriter effects around loading states because they conflict with real progress signals.

Correct path for real streaming messages:

- If needed, add a subtle opacity fade to newly arrived tokens.
- Show a streaming caret while `is_streaming` is true and remove it once the stream ends.

## 3. Keep As-Is

The following pieces already match the project's direction and should remain in place:

- Radix UI plus shadcn-style local source ownership in `components/ui/`.
- `react-virtuoso` and `react-arborist` for virtualization/tree rendering.
- `shiki`, `react-markdown`, and `remark-gfm` for code/markdown.
- `sonner` for notifications.
- `cmdk` for command-palette behavior.
- Current light/dark theme handling and the `viewTransition` wrapper.

When adding new compound components, follow the shadcn local-source pattern rather than hiding implementation in opaque packages.

## 4. Product Polish Policy

This section defines where polish is allowed and where it is forbidden.

### 4.1 Required Criteria

Any proposed visual effect must satisfy all three criteria:

1. Low frequency: the user sees it only a few times per session or at a specific milestone.
2. Not a scan surface: it is not a place where users rapidly compare dense operational information.
3. No conflict with real signals: it must not hide, delay, or distort real runtime progress.

Examples of forbidden mismatches:

- Typewriter on assistant streaming text makes the model look slower than it is.
- Animated profile table cells interfere with result comparison.
- Effects near loading indicators blur the line between decoration and progress.

### 4.2 Allowed Zones

| Surface | Effect Type | Preferred Implementation |
| --- | --- | --- |
| New-session `ChatPanel` empty state | Typewriter + caret | Local hook |
| `CommandPalette` placeholder or hint | Typewriter or flip words | Local hook or copied single component |
| First `ConnectWorkspaceDialog` guidance | Typewriter or blur fade | Local hook or copied single component |
| Artifacts empty state | Typewriter | Local hook |
| Connection established feedback | Subtle pulse or border beam | Tailwind or local component |
| `ContextPressureBanner` warning | Low-amplitude opacity/scale breathing | Motion |
| Future overview/status page | Component topology, number ticker, or bento layout | Copied source, reviewed per component |
| Future external landing/docs page | Richer visual effects | Separate page context only |
| Startup/about surface | Blur fade or shimmer | Copied source or Tailwind |

### 4.3 Forbidden Zones

Do not add fancy effects to:

- Assistant streaming message text itself.
- Session list rows, task rows, shell rows, timestamps, or metadata.
- Inspector JSON and key-value debug views.
- Profile and artifact table cells.
- Sonner toasts beyond built-in behavior.
- Loading or spinner-adjacent UI.
- File tree and explorer node labels.
- Settings and dialog form fields.

### 4.4 Milestone Trigger Rules

A milestone effect must correspond to a meaningful user-visible completion point:

- Allowed: first workspace connection succeeded, session created, export succeeded.
- Not allowed: every socket event, every message arrival, every click, every route switch.

The same milestone should trigger once per relevant session. Repeated operations should degrade to ordinary feedback.

## 5. Scoped Use of UI Libraries

These tools should not enter the main high-frequency work surfaces by default. They may be used in the approved polish zones with per-case review.

### 5.1 TanStack Router: Deferred

The dashboard has a small number of top-level sections, and the existing section state is sufficient. Router adoption should be reconsidered only when shareable deep links, browser back/forward semantics, or nested tab routes become real requirements.

### 5.2 MagicUI: Source-Copied Polish Only

Selected single components may be copied into approved polish zones, such as Number Ticker, Border Beam, Animated Beam, Blur Fade, or Flip Words. Do not install a broad dependency and then spread effects across the workbench.

Forbidden in the main workbench: marquee, broad confetti, shine borders, meteors, retro grids, and background decoration.

### 5.3 Aceternity UI: Future External Pages Only

3D cards, aurora backgrounds, tracing beams, container scroll, and parallax effects belong to external landing pages or documentation homepages, not the operational dashboard.

### 5.4 UI Generation Tools: Prototype Only

AI-to-UI generators may help sketch future external pages or polish prototypes. Generated code should not be dropped directly into the main dashboard because the workbench is deeply tied to live socket state and local patterns.

## 6. Dependency Version Notes

`lucide-react` is locked to a version that may diverge from the public community version line. Before large UI dependency changes, confirm whether that is intentional, a private fork, or a lockfile mistake.

## 7. Milestones and Order

| Phase | Work | New Dependency | Estimate | Risk |
| --- | --- | --- | --- | --- |
| 1 | Auto-animate pilot | `@formkit/auto-animate` | 1-2 days | Low |
| 2 | TanStack Query for HTTP | `@tanstack/react-query` | 2-4 days | Medium; socket boundary must stay clear |
| 3 | Motion on critical paths | `motion` | 1-2 days | Low |
| 4 | Typewriter + caret | None | 0.5 day | Very low |

Execution rule: each phase should be independently revertible. Phase 2 should be split by page where possible.

## 8. Non-Goals

- Do not do a whole-site visual redesign.
- Do not add a long-lived opaque component library.
- Do not rewrite the socket/session state layer.
- Do not add abstractions for speculative future needs.
- Do not chase visual impact in high-frequency work surfaces such as Chat, Explorer, Inspector, or artifact tables.

## 9. Implementation Record: 2026-07-11

Phases 1-4 were implemented in one batch.

### Phase 1: Auto-Animate

Dependency: `@formkit/auto-animate ^0.9.0`.

Implemented surfaces:

- `features/chat/TasksButton.tsx`: todo list insertion/deletion animation.
- `features/chat/BackgroundTerminalPanel.tsx`: shell task list animation.
- `features/chat/ChatPanel.tsx`: expanded container inside `ToolCallGroupBlock`.

Skipped surface: `ArtifactExplorerDialog`, because file/tree rendering is owned by virtualization/tree libraries.

### Phase 2: TanStack Query

Dependency: `@tanstack/react-query ^5`; devtools installed as dev-only but not wired into the UI.

Framework:

- `src/main.tsx` mounts `QueryClientProvider`.
- Defaults: `staleTime: 30s`, `gcTime: 5min`, `refetchOnWindowFocus: false`.

Migrated:

- `features/artifacts/useArtifactManifest.ts`: `/artifacts/manifest`.
- `app.tsx` `useModels`: `/models`.
- `features/docs/DocsPage.tsx`: `/docs/index` and `/docs/content` keyed by `selectedPath`.

Deferred:

- `SettingsDialog` settings/model mutations.
- Artifact internals around `/enhancement/action` mutations.

Test setup:

- `src/test/setup.ts` wraps Testing Library `render` in a fresh Query client and resets it after each test.
- `Element.prototype.animate` is stubbed because jsdom does not implement it and auto-animate expects it.

### Phase 3: Motion

Dependency: `motion ^12`.

Implemented surface:

- `features/chat/ContextPressureBanner.tsx`: entry fade/slide and low-amplitude breathing opacity for hard pressure.

Skipped:

- `ComposerFlipContainer` kept its CSS 3D flip and measured-height behavior because Motion `layout` did not cover the full behavior cleanly.
- Dialog/sheet transitions kept Radix defaults.

### Phase 4: Typewriter

No new dependency.

Added:

- `src/lib/useTypewriter.ts`: small local hook; reduced-motion returns full text immediately.
- `src/components/Typewriter.tsx`: component wrapper with timing and caret options.
- `src/index.css`: `.ak-caret` and `@keyframes ak-caret-blink`.

Implemented surfaces:

- `features/chat/ChatPanel.tsx`: empty-state H1.
- Product artifact empty-state copy where appropriate.
- `ErrorBoundary.tsx`: fallback body copy.

Skipped for later review:

- `CommandPalette` placeholder, because `cmdk` controlled placeholder behavior needs a separate design.
- `ConnectWorkspaceDialog` first-connection guidance.

### Validation at the Time

- `pnpm typecheck`: no new errors from this work. Existing errors were tied to unrelated workspace-renaming work in progress.
- `pnpm test`: nearly all tests passed; the one failure was tied to unrelated workspace-renaming work.
- `pnpm exec vite build`: passed. The dashboard JS bundle grew mainly due to `motion`; manual chunks or narrower imports can be considered later.

## 10. Deferred Work

- Move settings and product artifact mutations to `useMutation`.
- Revisit command-palette and first-connection typewriter polish after design review.
- Avoid number-ticker effects in product operational tables.
