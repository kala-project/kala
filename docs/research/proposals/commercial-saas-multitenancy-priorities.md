# Commercial SaaS Multitenancy Priority Gap

**Status:** planning baseline  
**Last reviewed:** 2026-09-08

## Conclusion

Agent RunLab already has a Private Cloud style multitenant foundation: an
authenticated ingress resolves an Organization to a Runtime Unit, forwards only
trusted tenant-routing headers, and the Runtime Host routes traffic to the
matching tenant runtime/data root. That is more than simple multi-user support.

It is not yet a complete commercial SaaS multitenant product. The remaining
work is mostly about making tenancy a durable commercial and operational
contract: lifecycle, authorization coverage, isolation proof, quotas, billing
hooks, high availability, compliance, observability, and tenant administration.

## Priority definitions

| Priority | Meaning |
|---|---|
| P0 | Required before serving mutually untrusted commercial tenants in one SaaS control plane. Missing items can cause tenant-boundary, billing, data-loss, or operability failures. |
| P1 | Required for a credible paid SaaS beta or enterprise pilot. Missing items create operational load, support risk, or incomplete admin/product flows. |
| P2 | Required for mature SaaS scale. Missing items are product polish, advanced enterprise capabilities, or later-stage efficiency improvements. |

## P0: commercial safety and tenant-boundary correctness

### P0 delivery ledger

| Feature | Current delivery state | Required completion evidence |
|---|---|---|
| Tenant lifecycle state machine | Complete for P0. Organization status is surfaced through the Organization model and inactive Organizations fail closed at RuntimeIngressGateway before runtime proxying. Provisioning service has targeted tests for provision/status transitions, Runtime Unit placement updates, session revocation, audit, and outbox writes. Runtime Unit delete writes a durable deleted tombstone; stale or newer resume/provision attempts cannot resurrect a deleted Unit. Destructive close requires exact confirmation and backup/PITR reference. | `provisioning.test.ts`, materialization tombstone tests, and `docs/operations/commercial-saas-tenant-lifecycle.md`. |
| Authorization coverage | Complete for P0. Gateway enforces runtime read/write, organization manage, policy manage, workspace manage for selected routes. Host Socket.IO rejects ingress `viewer` writes. Host HTTP session-scoped runtime routes reject ingress actors crossing Organization boundaries for tool-lock, admission messages, attachments, and session artifacts. Executor installation management is tenant-attributed and blocks cross-tenant admin access. Web-search credentials and settings write routes are admin-only. Background task, terminal, workspace file-list, workspace exec/binary-read, executor-ping, and overflow Socket.IO paths reject cross-tenant access and require a subscribed Session that owns the workspace. | Host route/socket matrix tests and RuntimeIngressGateway authorization tests. |
| Cross-tenant isolation evidence | Complete for P0. Runtime Unit routing, forged authority header stripping, inactive tenant runtime proxy denial, identical session IDs, HTTP artifacts, executor registries, shared workspace IDs across separate Units, deleted Unit tombstones, Host WebSocket subscription, Host HTTP session/artifact routes, workspace socket paths, and executor install management all have cross-tenant negative tests. | Runtime unit tests plus Host HTTP/socket negative tests. |
| Quota and entitlement enforcement | Complete for P0. Usage ledger validates token counts, fails closed without entitlements, and exposes `assertMonthlyTokenQuota()`. Host sessions persist tenant attribution; LLM calls, session creation, message queue admission, storage writes, executor attach/runtime accounting, and model selection/final provider calls all run injected fail-closed tenant enforcers before resource allocation. Service accounts have active-token quotas and raw-token non-persistence tests. Contract entitlements include workspace limits with a fail-closed `PostgresWorkspaceQuota` guard for workspace creation surfaces. | Usage ledger, Host quota/model/storage/executor tests, service account tests, and workspace quota tests. |
| Tenant retention and deletion | Complete for P0. Control-plane retention/export/delete flows are organization-scoped and tested. Host `SessionStore` purges sessions by persisted `organizationId`, using the same deletion path as user deletes so JSONL logs, log artifacts, artifact partitions, registered images, and attachments are tenant-scoped. Scheduled retention enumerates tenant policies, reports per-tenant failures, invokes the Host purge hook with the same cutoff, writes tenant-scoped audit events, and destructive close records backup/PITR confirmation. | Retention tests, Host purge tests, close confirmation tests, and lifecycle runbook. |
| Secret isolation | Complete for P0. Browser refresh tokens use encrypted secret box; product docs require server-side credential references. Shared persistence redaction covers secret keys, bearer tokens, API keys, workspace-root paths, signed URL query stripping, and truncation. Support ticket payloads, webhook outbox payloads, LLM traces, persisted event logs, session/RL exports, artifacts, operational errors, and model-context compaction prompts have redaction tests proving raw credentials are not persisted or sent cross-boundary. | Shared redaction, support, webhook, log/export, compaction, and runtime-config tests. |
| Control-plane persistence | Complete for P0. Production ingress requires `KALA_INGRESS_DATABASE_URL`; migration/import CLIs require database URL. Startup mode resolution prevents production JSON fallback while keeping non-production JSON explicit. Runtime ingress startup reads release migrations and fails closed unless database schema version exactly matches the running release, covering both behind and ahead rolling-deploy drift. | Control-plane mode tests, migration tests, schema compatibility tests, and lifecycle runbook. |
| Abuse and noisy-neighbor protection | Complete for P0. Unit resource governor supports per-unit concurrency, queue, and artifact-byte accounting. RuntimeIngressGateway has tenant/principal sliding-window rate limiting with 429/retry-after tests. Foreground shell, background shell, file reads, and terminal live streaming have bounded output paths; terminal sessions emit a truncation marker and are killed at budget. POSIX shells support CPU, virtual-memory, file-size, and process-count `ulimit` controls. Monthly token spend monitoring emits deduplicated tenant outbox alerts. Managed Linux Executor services install with systemd cgroup controls for CPU, memory, task count, file size, and no-new-privileges. | Rate-limit, output cap, shell-runtime, service adapter, and usage alert tests. |

P0 release evidence is not limited to unit tests. The current Dedicated
deployment at route generation 78 (`release-abfb1d724f724b4f454c`) completed a
planned restart handoff with 87/87 continuation participants settled and zero
failures. Product E2E evidence includes core workspace journeys, controlled
agent journeys, and the deployed official Copilot Runtime canary:
`/tmp/agent-runlab-program-1788878159267-2788853-b058e57c/report.json`,
`/tmp/agent-runlab-program-1788878331826-2795417-c789a14d/report.json`, and
`/tmp/agent-runlab-program-1788882875574-3038674-60776cd4/report.json`.

### Tenant lifecycle state machine

Define and enforce a durable tenant lifecycle:

- requested;
- provisioning;
- active;
- degraded;
- suspended;
- deleting;
- deleted;
- failed-provisioning.

Every transition must have an actor, audit event, retry behavior, and recovery
path. Runtime Unit materialization, routing readiness, default Workspace
creation, retention policy initialization, and tenant data root setup should be
part of the same observable lifecycle contract.

### Authorization coverage for every tenant-scoped operation

The existing organization and role model must be enforced consistently across
all APIs, WebSocket events, tools, sessions, workspaces, artifacts, executor
operations, admin endpoints, and background jobs.

P0 acceptance requires a negative test matrix proving that a principal from one
Organization cannot read, mutate, subscribe to, delete, or infer another
Organization's resources.

### Cross-tenant isolation evidence

Runtime Unit isolation must be converted from an architectural assumption into
release evidence. Required tests include:

- two-tenant session and event-log isolation;
- artifact and overflow-output isolation;
- workspace and executor isolation;
- tenant data-root path traversal resistance;
- forged browser header rejection;
- stale Runtime Unit generation rejection;
- tenant deletion not affecting other tenants.

For public SaaS with mutually untrusted code execution, this should also align
with the stronger isolation roadmap: at minimum process/container boundaries,
resource limits, and egress policy for higher-risk plans.

### Quota and entitlement enforcement

Control-plane schemas for usage and entitlements are not enough. Limits must be
enforced in the data path:

- concurrent sessions;
- queued turns;
- model/token budgets;
- executor minutes;
- storage and artifact size;
- workspace count;
- service account/API token count;
- model/provider availability by plan.

Quota exhaustion must produce explicit user-visible states instead of silent
failure, indefinite loading, or best-effort rejection after work has already
started.

### Tenant-scoped data retention and deletion

Retention policy must be executable, not just representable. P0 needs:

- scheduled retention jobs;
- per-tenant purge for sessions, artifacts, memory, overflow output, audit-safe
  metadata, and workspaces;
- suspend versus delete semantics;
- irreversible-delete confirmation;
- deletion audit trail;
- backup interaction rules.

### Secrets and credential isolation

Tenant secrets must never appear in Dashboard payloads, session logs, traces,
diagnostics, artifacts, or model-visible context. Required controls:

- server-side credential references only;
- tenant-scoped secret stores or key namespaces;
- rotation path;
- revocation path;
- redaction tests for support bundles and traces.

### Control-plane persistence and migration discipline

Commercial SaaS requires a single source of truth for tenant state. PostgreSQL
control-plane storage is appropriate for Private Cloud/SaaS mode, but the
product must make the production path explicit:

- no accidental production fallback to JSON stores;
- migration ordering and rollback policy;
- startup checks for required database configuration;
- backup and point-in-time restore runbook;
- schema compatibility gates during rolling deploys.

### Abuse, rate-limit, and noisy-neighbor protection

The shared control plane must protect itself and other tenants:

- per-tenant and per-principal API rate limits;
- queue depth limits;
- executor CPU/memory/disk/PID limits; POSIX shell commands can now be started
  under CPU, virtual-memory, file-size, and process-count `ulimit` budgets,
  but production SaaS still needs container/cgroup enforcement outside shell
  tools;
- output-size and artifact-size limits; live terminal output is capped and
  terminated after overflow, while shell/background/file paths already use
  bounded output buffers;
- model spend limits;
- alerting for abnormal usage.

## P1: paid beta readiness and enterprise pilot completeness

### Organization administration UI

Build an admin surface for:

- organization profile;
- member list;
- invites;
- role changes;
- workspace grants;
- retention policy;
- usage and quota status;
- service account management;
- audit-log search.

The UI must reflect forbidden, unauthorized, degraded, loading, and empty states
using the unified product state contract.

### Invite, onboarding, and membership flows

The code should support a full user journey:

- first tenant creation;
- invite issuance;
- invite acceptance;
- default role assignment;
- member removal;
- account deactivation;
- re-authentication after session expiry.

OIDC login alone is not enough; commercial tenants need understandable
organization onboarding and recovery flows.

### Billing and metering integration boundary

Even if external billing is intentionally out of scope for Private Cloud, SaaS
needs a clean billing integration boundary:

- immutable usage ledger events;
- tenant plan and entitlement snapshots;
- invoice/export API;
- overage state;
- grace period;
- manual credit/override audit trail.

The enforcement path should not depend on the eventual billing vendor.

### High availability and rollout operations

SaaS mode needs a documented and tested path for:

- multiple ingress replicas;
- control-plane database failover;
- Runtime Unit scheduling across hosts;
- drain/migrate semantics;
- rolling deploys;
- zero-downtime schema migrations;
- stale worker rejection;
- tenant-aware health checks.

### Per-tenant observability and support tooling

Operators need tenant-scoped metrics, logs, traces, and diagnostic bundles:

- tenant ID and runtime unit ID on low-cardinality metrics;
- support-safe trace correlation IDs;
- audit-visible support access;
- tenant health page;
- usage anomaly alerts;
- failed authorization decision logs.

Support access must be explicit, time-bounded, and auditable.

### Workspace-level RBAC completion

Organization roles are not enough for SaaS. Workspace-level grants must be
applied consistently to:

- session creation;
- file browsing;
- shell/executor access;
- artifact access;
- Git operations;
- memory operations;
- sharing and viewer access.

### Enterprise identity baseline

For enterprise pilots, implement the practical minimum:

- per-tenant OIDC/SAML configuration;
- domain claim or tenant discovery;
- JIT provisioning policy;
- IdP metadata rotation;
- session expiry and logout semantics;
- optional SCIM design boundary.

### Compliance export basics

Add tenant-facing exports for:

- audit log;
- usage;
- members and roles;
- workspace inventory;
- data-retention settings;
- deletion request status.

## P2: mature SaaS scale and differentiated enterprise capabilities

### Self-service plan management

Add productized plan management:

- plan comparison;
- trial conversion;
- upgrade/downgrade;
- add-on capacity;
- renewal state;
- admin notifications.

### Advanced tenant placement and regionality

Support:

- region selection;
- data residency;
- tenant migration between regions;
- warm pools by region;
- capacity forecasting;
- placement constraints for regulated tenants.

### Advanced security controls

Later enterprise controls include:

- customer-managed keys;
- tenant egress allowlists;
- private networking;
- IP allowlists;
- device posture hooks;
- break-glass approval workflow;
- SIEM streaming.

### Tenant analytics and cost optimization

Expose mature reporting:

- cost by workspace/session/model;
- latency by provider/runtime unit;
- idle resource recommendations;
- quota forecast;
- noisy workflow detection;
- executor utilization.

### Marketplace and extension governance

If the product grows tool/provider extensibility, SaaS needs tenant governance:

- approved tool catalog;
- provider policy;
- per-tenant MCP server allowlist;
- extension audit;
- sandbox policy by extension risk.

### Customer success workflows

Add operational product workflows:

- onboarding checklist;
- health score;
- renewal risk signals;
- admin education prompts;
- support case bundle generation;
- tenant-level incident history.

## Recommended implementation order

1. Finish P0 authorization coverage and isolation tests before adding more
   visible SaaS controls.
2. Implement tenant lifecycle state machine and quota enforcement together,
   because both must gate Runtime Unit provisioning and session execution.
3. Add admin UI only after the backend contracts are enforceable and audited.
4. Move to P1 HA, observability, and onboarding for a paid beta.
5. Treat P2 as scale and enterprise differentiation, not launch blockers.

## Minimum acceptance bar before calling it commercial SaaS

The product should not be called complete commercial SaaS multitenancy until all
P0 items pass automated acceptance and the following evidence exists:

- two-Organization isolation suite;
- tenant lifecycle integration suite;
- quota enforcement suite;
- retention and deletion suite;
- secret redaction suite;
- ingress/header-forgery security suite;
- control-plane migration and backup/restore runbook;
- operator runbook for tenant suspend, restore, and incident response.
