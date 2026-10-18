# Current Program Baseline

**Status:** historical frozen baseline despite the filename; not current runtime state.

**Captured:** 2026-07-30
**Source revision:** `1e01821a46f05b703db6fc97b6cd61cb6d179dc4`
**Purpose:** freeze deployment boundaries and evidence locations before the product-hardening program starts.

**Historical terminology:** this frozen 2026-07-30 record preserves the deployment names and runtime labels captured at that time. Current product names are Portable, Dedicated, and Private Cloud; see [`../architecture/deployment-mode-contract.md`](../../architecture/deployment-mode-contract.md).

## Safety rule

- The existing Standalone LXD service on `127.0.0.1:13000` is frozen.
- No intermediate task may replace its bundle, restart its service, or mutate its user data.
- The only permitted LXD mutation is the final `markdownLxdDeploy` graph node after Docker, Box Standalone, browser acceptance, and the deployment quality gate have passed.
- Before that final deployment, create a timestamped bundle backup and record its digest.

## Current runtime snapshot

| Runtime | State |
|---|---|
| Standalone LXD `13000` | active; PID `19125` |
| LXD bundle SHA-256 | `2b678c8acb7b7806201922e0eed198ff846d987fbbc12284c950e9e31eef8d66` |
| Hosted product `13001` | Docker Gateway healthy |
| Hosted Runtime Host | Docker Host healthy |
| Identity `13002` | Docker identity proxy/ZITADEL healthy |
| PostgreSQL | Docker, healthy, no published database port |
| Acceptance LLM | Docker mock provider running; protocol evidence only |

## Working tree

The shared working tree contains 176 modified/untracked paths from the ongoing cross-package program. These changes are intentional shared-session state and must not be reverted wholesale. Every edit must be focused and preserve unrelated changes.

## Isolated validation environments

- **Hosted multi-user:** existing Docker Compose stack at `13001/13002`; use newly created temporary identities and Unit-scoped resources for each run.
- **Standalone pre-release:** run the production bundle directly on the Box using an unused loopback port selected at runtime, a temporary HOME/data root, and temporary Executor roots. Do not use port `13000`.
- **Browser evidence:** write screenshots and JSON reports under `/tmp/agent-runlab-program-<timestamp>/`; reports include URL, viewport, failed requests, console/page errors, resource IDs, and cleanup result.
- **Persistence/restore:** disposable Docker volumes and temporary directories only until the final release node.

## Current unfinished feature slice

The working tree contains the Code Block stability and Mermaid implementation:

- stable position-keyed Markdown blocks;
- deferred Shiki enhancement while a fence is still streaming;
- lazy Mermaid rendering with strict security mode;
- invalid Mermaid source fallback;
- focused tests.

This slice must be reviewed and verified through the new E2E harness before any LXD deployment.
