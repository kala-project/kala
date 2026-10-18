# Product Deployment Contract

**Status:** normative
**Scope:** product naming, deployment configuration, tenancy, capabilities, trust boundaries, and release acceptance
**Last verified:** 2026-08-20

## 1. Canonical product names

Agent RunLab has two runtime architectures and three user-facing variants. Every variant is operated by the user; the project does not define an officially managed service.

| Product | Architecture | Tenancy | Meaning |
|---|---|---|---|
| **Portable** | `portable` | effectively single-tenant | One distributable CJS or native binary, directly managed by the user |
| **Dedicated** | `platform` | `single-tenant` | The complete Platform dedicated to one tenant |
| **Private Cloud** | `platform` | `multi-tenant` | The complete Platform serving isolated tenants |

`Dedicated` and `Private Cloud` are configurations of the same Platform architecture. They are not defined by node count: either may evolve from one node to multiple nodes. `systemd`, containers, and Kubernetes are infrastructure choices, not product modes.

Removed product-mode names are not accepted as configuration aliases. New source, protocols, documentation, environment files, and operator commands use only the canonical schema and names.

## 2. Versioned configuration

The authoritative configuration is JSON so the CJS bundle, native packaging, systemd installer, containers, and tests share one strict parser.

Portable default:

```json
{
  "schemaVersion": 1,
  "architecture": "portable",
  "runtimeProfile": "full"
}
```

Dedicated:

```json
{
  "schemaVersion": 1,
  "architecture": "platform",
  "tenancy": "single-tenant",
  "runtimeProfile": "full"
}
```

Private Cloud:

```json
{
  "schemaVersion": 1,
  "architecture": "platform",
  "tenancy": "multi-tenant",
  "runtimeProfile": "agent"
}
```

`runtimeProfile` is a capability composition (`full` or `agent`), not a tenancy shortcut. Either Platform tenancy may select either profile. Unknown versions, fields, architectures, tenancy values, and profiles fail closed.

The Runtime reads `KALA_DEPLOYMENT_CONFIG`. Direct execution without this file is Portable. Platform deployments must provide the versioned file; no legacy mode environment variable is supported.

## 3. Topology is orthogonal

These are valid examples:

```text
Portable + one process
Dedicated + systemd + one host
Dedicated + Kubernetes + multiple nodes
Private Cloud + containers + one host
Private Cloud + Kubernetes + multiple nodes
```

The current Dedicated systemd implementation uses the second line: Dedicated on systemd with Stable Ingress, one logical `local` Runtime Unit, blue/green process slots, and Deploy Supervisor. The `local` Unit and one-host layout are properties of that installer, not the definition of Dedicated.

## 4. Capability contract

`GET /runtime/capabilities` returns authoritative product configuration and capabilities:

```json
{
  "product": "dedicated",
  "deployment": {
    "schemaVersion": 1,
    "architecture": "platform",
    "tenancy": "single-tenant",
    "runtimeProfile": "full"
  },
  "capabilities": {
    "agent": true,
    "workspace": true,
    "operations": true,
    "artifacts": true,
    "pipeline": true
  }
}
```

The Dashboard remains fail-closed until it validates the whole payload. A failed or malformed request must not infer Dedicated or expose disabled capabilities. Server checks remain authoritative.

The current `agent` profile keeps Agent, Workspace, Executor, File, Git, Shell, and Artifacts while disabling Operations/Pipeline entry points. Disabled capabilities must be absent from navigation and denied by raw HTTP and Socket.IO protocols.

## 5. Identity and routing

Portable and Dedicated may use local/shared-token authentication and route to their configured Runtime Unit without an end-user tenant selector. Private Cloud uses an external Gateway/identity service to map an authenticated identity to an opaque `TenantRuntimeUnit` assignment.

For every Private Cloud HTTP request, Engine.IO poll, and WebSocket upgrade, the Gateway:

1. verifies the product session;
2. resolves the immutable identity assignment;
3. removes browser-supplied routing authority;
4. writes a trusted opaque Unit route and service credential;
5. keeps that route stable for the connection lifetime.

The Runtime Host knows Unit tenancy and deployment-boundary credentials, not user profiles, passwords, OIDC tokens, organizations, memberships, billing identity, or RBAC policy.

## 6. Unit isolation

Each `TenantRuntimeUnit` owns separate Session stores, queues, Workspace/Executor identities, operation receipts, artifacts, notifications, Socket.IO servers, namespaces, adapters, recovery state, caches, timers, and mutable roots. Tests deliberately reuse identifiers across Units and prove no leakage.

Logical process-local isolation is not claimed as container/VM isolation. Multi-node placement requires explicit leases and fencing; copied files do not grant writer ownership.

## 7. Release lanes

Platform releases have separate Runtime/control-plane and Dashboard artifacts. Stable
Ingress serves or proxies the active Dashboard generation independently from active Runtime
Units. A Dashboard-only activation changes no Runtime PID/container, Unit route generation,
write lease, Session continuation marker, or Executor connection. Dedicated uses a
versioned request/receipt protocol and atomic static-release route state; Private Cloud uses
an independently replaceable Dashboard image. Portable alone embeds Dashboard assets in
the CJS/native executable and upgrades them together. Long-lived browser tabs periodically
check the Dashboard Service Worker, automatically activate a newly waiting generation, and
perform one controlled reload; unsent Composer drafts survive that reload. A tab does not
remain indefinitely on mixed assets merely because Socket.IO still reports connected.

### Portable

- execute the released CJS and each supported native binary directly;
- create and recover Sessions and Workspaces;
- exercise Browser, Executor, File/Git/Shell, Artifacts, Operations, and Pipeline according to the configured runtime profile;
- verify graceful shutdown and documented replace-and-restart upgrade semantics.

### Dedicated

- install the systemd topology disabled;
- prove Stable Ingress, blue/green Runtime Unit replacement, admission reconciliation, planned continuation, exact release digest, Supervisor recovery, and automatic rollback;
- verify desktop/mobile/PWA, Browser and Executor reconnect, full capability flows, backup/restore, and observation-window rollback readiness.

### Private Cloud

- deploy the complete user-operated container/Kubernetes stack behind one product Origin;
- create at least two temporary identities and isolated Units;
- reuse identifiers across Units and prove Session, Workspace, Executor, File, Shell, Artifact, and notification isolation;
- prove authentication lifecycle, Gateway bypass denial, HTTP/WebSocket stickiness, backup/restore, upgrade, and cleanup.

A rendered page or HTTP 200 alone is never task-chain acceptance.

## 8. Derived documents

- Dedicated systemd architecture: [`dedicated-platform-runtime-unit.md`](dedicated-platform-runtime-unit.md)
- Private Cloud Runtime Units: [`private-cloud-runtime-units.md`](private-cloud-runtime-units.md)
- Dedicated operator lifecycle: [`../operations/dedicated-operator-cli.md`](../operations/dedicated-operator-cli.md)
- Dedicated cutover runbook: [`../operations/dedicated-platform-runtime-unit-cutover.md`](../operations/dedicated-platform-runtime-unit-cutover.md)
- Historical legacy migration handoff: [`../operations/dedicated-platform-systemd-external-agent-handoff.md`](../archive/programs/dedicated-platform-systemd-external-agent-handoff.md)
- Private Cloud local operations: [`../operations/private-cloud-local-runbook.md`](../operations/private-cloud-local-runbook.md)
- Authenticated browser shell: [`../design/authenticated-product-shell.md`](identity-and-security/authenticated-product-shell.md)
- Verification policy: [`../meta/testing.md`](../standards/release-quality/testing.md)

If a derived document conflicts on product naming, configuration, capability shape, tenancy, or identity ownership, this contract wins.
