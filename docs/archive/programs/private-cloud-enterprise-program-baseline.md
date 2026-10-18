# Private Cloud Enterprise Program Baseline

Status: frozen for implementation

## Product boundary

Agent RunLab Private Cloud targets trusted enterprise users provisioned through an operator-reviewed contract. Operators run the authenticated control plane, tenant-isolated Runtime Units, and their own outbound-only Executor fleet.

In scope:

- Organization is the commercial and security tenant.
- Workspace is the authorization, policy, and execution boundary inside an Organization.
- Organization- and Workspace-scoped Executor pools.
- Human contract provisioning, contractual entitlements, enterprise identity, audit, retention, support, and operational controls.
- Single-domain product ingress; identity-provider administration remains an operator surface.
- Core Agent Session, Queue, Steer, Approval, Compact, Sub-agent, Task Graph, Executor protocol, and recovery remain first-party.
- Mature infrastructure capabilities use reviewed OSS adapters where practical.

Explicitly out of scope:

- public self-service signup or billing;
- public shared execution of untrusted workloads;
- a home-grown identity provider, ticket lifecycle, secret vault, object store, observability database, or policy language;
- tenant subdomains as a routing requirement.

## Frozen trust boundaries

1. Browser traffic enters one Runtime Ingress Gateway and is authenticated before tenant routing.
2. Organization identity is derived from the authenticated server-side principal, never a browser-supplied tenant id.
3. Each Runtime Unit owns isolated Session, Queue, Executor registry, Artifact, Push, and operational state.
4. Customer Executors initiate outbound TLS/WSS only and receive least-privilege Organization/Workspace-scoped credentials.
5. LLM and integration secrets are resolved by reference at the server boundary and are never exposed to browsers or unrelated tenants.
6. Cross-tenant identifiers may collide; isolation cannot depend on globally unique client-provided ids.

## Deployment baseline (2026-07-31)

- Portable release bundle: `release/kala-dashboard-with-runtime.cjs`; Platform Runtime and Dashboard use separate artifacts.
- LXD `agent-runlab-host`, port `13000`: deployed SHA-256 `b9cd67182903e0743f8d393b1e79598292a1c091a33ef4e3a83e546ddffce477`.
- Deployment used checkpoint restart attempt `01KYWH25WAFV55A2Q9A4XT244W`; old PID `23320`, new PID `23438`; restart completed and runtime/model health probes passed.
- Rollback artifact retained at `/home/ubuntu/.bin/kala-dashboard-with-runtime.cjs.rollback`.
- Private Cloud Docker execution remains an acceptance environment and must not be confused with every possible production topology.

## Quality baseline

The preceding core-hardening program passed repository typecheck, Dashboard 763 tests, Kernel 58 tests, Executor 165 tests, Host 851 tests (2 skipped), Gateway 20 tests, release verification, desktop/mobile/PWA browser matrices, isolated Dedicated smoke, and multi-tenant Runtime Unit isolation tests.

Known operational constraint: direct access to `/var/run/docker.sock` is denied for the current shell identity. Private Cloud deployment evidence requiring Docker must use an authorized runner rather than weakening socket permissions.

## Change control

- Database, identity, routing, Executor enrollment, and secret changes require migration and rollback evidence.
- LXD deployment is never an intermediate test mechanism; it follows all disposable environment gates.
- Shared workspace changes must not be rolled back wholesale.
- A graph node is complete only when implementation and its narrowest reliable acceptance evidence exist.
