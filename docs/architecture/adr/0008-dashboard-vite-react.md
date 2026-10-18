# ADR 0008: Dashboard is a Vite + React SPA, not Next.js

**Status**: accepted
**Date**: 2026-07-04

## Context

The Dashboard is the visualization layer — a React app that subscribes to a Host session over Socket.IO and renders chat + inspector + replay/fork UI.

React ecosystem defaults for a new project in 2026 are Next.js (App Router) or a Vite + React setup. Next.js is what most tutorials, most job postings, and most "recommended stack" articles push. It's the safe answer.

For `agent-kernel` though, the Dashboard has three properties that push against Next.js's strengths:

1. **No server-side rendering needed.** The Dashboard is entirely dynamic — every pixel is driven by real-time Socket.IO events. SSR of the initial shell buys nothing.
2. **No server needed at all.** The Dashboard is a static bundle. Data comes from Host over the wire. Deploy target is any static host (Cloudflare Pages, GitHub Pages, or Host itself serving `/`).
3. **The Dashboard must be independently deployable from Host.** A user who runs Host on Fly.io should be able to point at `https://dashboard.example.com` served from anywhere. Coupling the frontend to a Node runtime undermines this.

## Decision

**Vite + React 18 + TypeScript strict, shipped as a static SPA. No Next.js, no server components, no SSR.**

Router: `@tanstack/react-router` (or `wouter` — a per-file decision, both are fine). Styling: Tailwind + shadcn/ui. Wire: `socket.io-client`. Tests: Vitest + `@testing-library/react` for components, plus Puppeteer verification scripts for production-shape browser checks.

## Alternatives considered

**Next.js App Router.**

*Rejected*. Its main features — SSR, RSC, route handlers, edge functions — provide no value for a Socket.IO-driven live dashboard. It also introduces a Node runtime as a deployment surface, which contradicts the "deploy as static bundle anywhere" property we want. In practice, we'd disable most of what Next brings and be left with a slower dev server and more config than needed.

**Remix / TanStack Start.**

*Rejected*. Same story as Next.js — they optimize for full-stack apps where server-rendered pages matter. Our dashboard has no such pages.

**Create React App.**

*Rejected*. Deprecated / unmaintained. Vite is the modern equivalent and strictly faster.

**Vanilla web components + Lit.**

*Considered*. Would produce a smaller bundle and force cleaner boundaries. Rejected because the pool of contributors familiar with React is much larger, and this is a project meant to be readable and forkable. Optimization for accessibility over binary size.

**A TUI instead of a web dashboard.**

*Considered as an addition, not a replacement*. A TUI would miss the whole point — the replay/fork UI is a visual argument. But nothing prevents someone from building a TUI against the same wire protocol later, and the [ROADMAP](../../roadmap.md) "Post-v1" section keeps that door open.

## Consequences

**Good**:
- Dashboard `dist/` is a plain static bundle. Ships in ~200 KB gzipped once we're paying attention. Any static host works.
- Dev experience: Vite HMR is fast. No Next.js config surface to grow into.
- No coupling between Dashboard and Host deployment: user can update either independently.
- Aligns with the "Dashboard deploys anywhere the URL can be reached" property in the [README](../../README.md).

**Bad**:
- We forgo Next.js SEO/OG features for the marketing page. Mitigation: the marketing page for `agent-kernel` doesn't live in the Dashboard app — it can be a separate static site if it ever exists.
- No native SSR fallback for users on very slow first paint. In practice a Socket.IO-connected dashboard doesn't render meaningfully without JS anyway.
- We're going against the ecosystem-default recommendation. Some contributors will suggest "just use Next.js" — this ADR is the pre-canned response.

## Verification

- [`packages/dashboard/package.json`](../../../packages/dashboard/) declares `vite` as the dev dep, not `next`.
- No `pages/` or `app/` directory under `packages/dashboard/src/` — routes live in `src/routes/`.
- Build output is a plain `dist/` folder deployable to any static host.
