# Contributing to Kala

Thanks for contributing to Kala. The project favors explicit contracts,
recoverable state transitions, and readable implementations over feature velocity.

---

## Ground rules

1. **Specs are normative, code follows.** If your change contradicts a doc, update the doc in the *same* PR. If the spec is wrong, fix the spec first, then the code.
2. **The kernel is holy ground.** Any PR that grows [`packages/kernel/src/`](packages/kernel/src/) needs justification against [ADR 0001](docs/architecture/adr/0001-pure-reducer.md) and [ADR 0005](docs/architecture/adr/0005-kernel-boundary.md). "It's convenient" is not enough — the kernel is meant to be readable in one sitting.
3. **Prefer tightening the spec over loosening it.** Adding an escape hatch is a design smell.

---

## Before you open a PR

- [ ] `pnpm run typecheck` passes
- [ ] applicable targeted tests and `pnpm run test:fast` pass
- [ ] `pnpm run privacy:check` and `pnpm run verify:licenses` pass
- [ ] Doc changes are in the same PR as the code changes they describe
- [ ] Commit message explains the *why*, not the *what* (the diff already shows the what)

---

## Scope of what's welcome

**Very welcome:**
- Bug fixes in the kernel FSM with a failing test that reproduces the bug
- Doc improvements — typos, unclear passages, missing rationale, better examples
- New LLM adapters (OpenAI, DeepSeek, Bedrock, local via ollama) — as long as they conform to the `LLMAdapter` interface
- New Executor tools — as long as they're generally useful, have a JSON schema, and follow the pattern in [`docs/reference/executor/tools.md`](docs/reference/executor/tools.md)
- Better dashboard UX

**Consider before opening:**
- New wire events — coordinate with a maintainer first, protocol changes cascade
- Larger deferred items in [`docs/roadmap.md`](docs/roadmap.md) — open an issue for discussion
- Adding runtime deps to the kernel — needs a strong justification

**Not welcome:**
- Adding planning / memory / subagents to the kernel (see [ADR 0005](docs/architecture/adr/0005-kernel-boundary.md))
- Introducing a separate relay process for v1 (see [ADR 0006](docs/architecture/adr/0006-no-relay-process.md))
- Swapping Socket.IO for a different transport without discussion (see [ADR 0003](docs/architecture/adr/0003-socket-io.md))
- Making kernel functions async (kills purity)

---

## Development setup

```bash
git clone https://github.com/<owner>/agent-kernel
cd agent-kernel
pnpm install
pnpm hooks:install   # opts in to the repository privacy pre-commit/commit-msg/pre-push hooks
pnpm -r build
pnpm -r test
```

Requirements:
- Node ≥ 22
- pnpm 11.3.0 through Corepack

For the Dashboard, you'll also need a browser and a running Host instance — see
the [top-level Quick Start](README.md#quick-start-from-source).

---

## Repo layout

See the [README](README.md#repository-layout).

Each package has its own README. Read those first when working on a package.

---

## Commit and PR style

- **Commits**: one logical change per commit. Squash noise before pushing.
- **PR titles**: `<scope>: <verb-phrase>`, e.g. `kernel: fix cursor off-by-one after reject event`.
- **PR bodies**: what changed, why, what tests were added. Link to the ADR or spec section your change touches.

---

## Filing bugs

Include only redacted information:
- Package + version
- Node version
- Minimal reproduction (ideally a failing test)
- Actual vs. expected

Bugs in the kernel are easier to reproduce than bugs in the host loop — for kernel bugs, please try to reduce to a `step()` call sequence in a Vitest file.

---

## Design discussion

The best way to influence a big design decision is to draft an ADR (see the format in [`docs/architecture/adr/0000-index.md`](docs/architecture/adr/0000-index.md)) and open a PR against `docs/architecture/adr/`. This forces the discussion to converge on written trade-offs rather than drifting in issue comments.
