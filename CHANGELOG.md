# Changelog

All notable user-facing changes are recorded here. The project follows Semantic
Versioning while pre-1.0 and uses one product version across release artifacts.

## [Unreleased]

## [0.4.3]

### Improved

- Opt-in unified Settings organizes configuration and administration by authority,
  with conditional writes, effective-state feedback, and restricted Operator maintenance.
- Session lists load stored summaries and replay restored events in bounded batches.

### Fixed

- Mobile user-message timestamps and metadata no longer overlap message text.
- Session operation feedback preserves the authoritative Agent status.
- Dedicated SILO Console uses explicit Owner-gated launch and credential handoff,
  with authenticated WebSocket forwarding through retained and direct ingress.
- Public release promotion refreshes the website even when publication uses
  the workflow token.

### Upgrade boundaries

- Existing installations retain the legacy Settings layout until
  `KALA_SETTINGS_LAYOUT=unified` is deliberately enabled.
- Expanded PostgreSQL schemas require Operator-run migration and a compatible
  rollback build; pre-expansion binaries and schema downgrades are not rollback targets.
- Native SILO administration retains its separate login. Private Cloud remains
  preview-only and requires external OIDC, postgres-s3, and explicit evaluation
  and backup acknowledgements for fresh installs.

## [0.4.2]

### Fixed

- Runtime preserves the attachment transfer capability sent by current Devbox
  Executors instead of incorrectly requiring an Executor upgrade.
- Failed tools report actionable diagnostics without redundant generic text;
  attachment transfers rejected before dispatch no longer imply an uncertain write.
- The Windows Portable download instructions verify the manager signature and
  checksum, then install and start the Host.

### Added for v0.3.0

- Dedicated fenced Runtime ownership, durable Session and Executor recovery,
  independent Dashboard releases, and Owner administration.
- Private Cloud tenant-scoped authority, exports, and durable background work.
- Windows x64 Portable Host and native Executor with ConPTY release and
  acceptance workflows; availability depends on exact-tag hosted acceptance.

### Fixed for v0.3.0

- Dedicated Executor invite installation is routed through public ingress.
- Dashboard connection health popup remains visible and clickable.
- Release checks bind Portable and Private Cloud artifacts to the exact revision.

## [0.2.0] - 2026-10-02

### Added

- Near-full-screen views for the workspace terminal and task graph.
- Portable, Dedicated, and Private Cloud deployment variants.
- Independent Platform Dashboard releases.
- Stable Ingress, blue/green Runtime slots, durable admission, planned Session
  continuation, and Supervisor-owned rollback for Dedicated.
- Digest-pinned multi-architecture Private Cloud images, native Linux operator
  bundles, independent Dashboard upgrades, and state-machine lifecycle receipts.
- Release asset integrity checks, explicit vulnerability policy, and managed
  Windows Executor service install/uninstall lifecycle.
- A production-component Dashboard prototype harness with transport-boundary
  mock data and a browser interaction matrix.

### Changed

- Private Cloud runtime images now derive a digest-pinned, non-root Node.js
  runtime containing only required libraries and their package inventory.
- README architecture narrative now presents the pure-function Agent Kernel,
  Agent Runtime, and cloud-native service as one complete system.
- Thinking titles remain visible when collapsed, and reasoning direction now
  precedes the tool activity it introduces.
- Dashboard navigation, title, Composer, Operations, Product Outputs, Pipeline,
  Memo, Settings, responsive states, and Chinese localization use the shared
  product UI system.
- Session and Workspace information, cumulative usage, storage inventory,
  sub-agent activity, message timing, pinned prompts, hidden items, and
  responsive sidebars use denser production layouts.
- Ask User Choice supports single-choice, multiple-choice, and custom responses
  through one shared Dashboard and Host protocol.

### Fixed

- Pending Ask User Choice requests remain visible when Copilot emits an
  intermediate idle state before the user responds.
- Context progress animation, message metadata spacing, compact Choice cards,
  storage sorting, sidebar truncation, and narrow right-panel tabs retain their
  intended geometry.

### Release

- `v0.2.0`, after every gate in the public release readiness runbook passes.
- Kala branding and safer installation documentation; no automatic npm publishing.
