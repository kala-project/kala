# Platform Deployment Feature Review Ledger

**Status:** historical review snapshot; not current release evidence.

**Status:** current review record
**Reviewed:** 2026-07-29
**Normative contracts:** [`../architecture/deployment-mode-contract.md`](../../architecture/deployment-mode-contract.md), [`critical-user-action-matrix.md`](../../development/testing/critical-user-action-matrix.md)

This ledger records implementation evidence and remaining review work. It is not a replacement for task-chain acceptance.

| Feature | Dedicated | Private Cloud | Implementation evidence | Strongest existing proof | Remaining release proof |
|---|---|---|---|---|---|
| Agent | Enabled | Enabled | Kernel core, Host loop, Dashboard chat | Kernel/Host suites; real Dashboard scripts | two-user real task chain through Gateway |
| Session | Enabled | Enabled, Unit-scoped | SessionStore, queues, Socket.IO rooms inside Unit | same Session IDs across two Units | identity-to-Unit browser enumeration denial |
| Workspace | Enabled | Enabled, Unit-scoped | Explorer, alias store, internal/external Executor | Unit-local Executor and workspace tests | two-user external Executor reconnect |
| File | Enabled | Enabled | Executor FS handlers and SessionFilesPanel | sandbox and component tests | large/binary/path-denial transport chain |
| Git | Enabled | Enabled | SourceControlPanel over workspace execution | component tests | real repositories, empty/error/unavailable states |
| Executor | Enabled | Enabled, invite-bound | registry, identity store, Gateway invite route | Unit registry isolation | token rotation/revocation and multi-process reconnect |
| Shell/terminal | Enabled | Enabled | Executor terminal/background handlers and Dashboard panels | handler/component tests | resize, cancellation, disconnect cleanup through Private Cloud |
| General Artifacts | Enabled | Enabled, Unit-scoped | registries and Artifact pages | cross-Unit artifact test | download/retention and two-user browser denial |
| Settings | Enabled | Enabled | Settings sections and Host projections | broad component suite and layout scripts | execute every visible mutation and recovery path |
| Accounts | N/A | External IdP/Gateway | `/auth/login`, callback, `/auth/me`, logout | Gateway request-path tests and browser logout evidence | server revocation, global logout, expiry warnings, devices |
| Notifications | Enabled | Enabled, Unit-scoped | Host push store, activity tracker, SW, device UI | push and Settings tests | real browser Push and remote-device browser actions |
| PWA | Enabled | Enabled | manifest, production SW, cache namespace | mobile/PWA scripts | update/offline/push lifecycle and iOS real device |
| Benchmark | Enabled | Disabled | capability projection and Host action classifier | runtime capability tests | enumerate all HTTP/Socket.IO denial paths |
| Evaluation | Enabled | Disabled | capability projection and Host action classifier | runtime capability tests | enumerate all HTTP/Socket.IO denial paths |
| Responsive UI | Required | Required | shared Dialog/Sheet and viewport primitives | viewport screenshot matrices | active keyboard, rotation, nested modal states |
| Streaming scroll | Required | Required | VirtualTranscript pin state | component tests | real upward scroll while tokens/tools append |
| Sub-agent/dot mode | Enabled | Enabled | Grouped SubAgentCard, multiplexed child channel, compact tool rail | component checks for cross-message grouping/policy disclosure; replay browser geometry and computed typography | real concurrent children through Copilot and Kernel, including interruption/failure |
| Message attachments | Enabled | Enabled, Unit-scoped | raw-byte upload, Host content-addressed store, Session-scoped `host_ref`, controlled Copilot SDK file and Kernel text resolution | store/route/client/Composer tests cover integrity, viewer denial, pending release/expiry, attachment-only queue restart, Windows containment, and real SDK Markdown sentinel reading | full browser-to-ingress Markdown sentinel flow against each production runtime |

## Prioritized findings

### P0/P1 fixed in this review

- Added one normative deployment-mode contract and corrected the obsolete tenant-hostname runbook acceptance.
- Changed Dashboard capability bootstrap to fail closed instead of inferring Dedicated after fetch failure.
- Added Gateway request-path tests for callback state consumption, account projection, trusted routing-header overwrite, unauthenticated behavior, and logout origin/method enforcement.
- Expanded critical user actions to mode-aware task chains and cleanup/evidence rules.

### P1 implementation/test work still required

1. Enumerated Private Cloud Benchmark/Evaluation denial matrix rather than one representative endpoint.
2. Two-authenticated-user browser flow for Session, Workspace, external Executor, File, Shell, Artifact, and notification-device isolation.
3. Settings action automation beyond geometry/navigation.
4. Real scrolling interaction while streaming and tool/sub-agent expansion.
5. Service-worker update/offline/Push lifecycle tests and iOS release evidence.
6. Server-revocable product sessions, device/session list, cross-device logout, provider-wide logout, and expiry warning.

### Architectural limitations, not hidden bugs

- Unit isolation remains logical within one Node.js Host process.
- Assignment/login/control persistence is single-node JSON storage.
- The local Compose stack is not a multi-replica production deployment.
- A mock LLM proves protocol behavior only; production provider compatibility needs a separate lane.
