# Unified SaaS Design Re-audit — 2026-08-01

**Status:** historical re-audit snapshot superseded by current Private Cloud contracts and revision-bound evidence.

**Historical terminology:** this frozen 2026-08-01 re-audit preserves the removed product name used when its evidence was captured. Its current successor is Private Cloud; see [`../architecture/deployment-mode-contract.md`](../../architecture/deployment-mode-contract.md).

## Frozen product contract

- Trusted enterprise customers, manually provisioned contracts, customer-owned outbound-only Executors.
- One product origin through Runtime Ingress Gateway; no tenant subdomains.
- ZITADEL owns authentication/MFA/federation. PostgreSQL owns control-plane authority.
- Runtime Host owns core Agent state machines; Organization-scoped Tenant Runtime Units isolate runtime state.
- Session JSONL is the authoritative hot Session record and must live on one shared NFS-backed `tenant-data` volume at `/var/lib/kala` for every SaaS deployment.
- MinIO/S3 stores Artifacts, exports, support bundles, and archived immutable Session segments; it is not the active JSONL filesystem.
- SaaS hides Benchmark/Evaluation only. Workspace, File, Git, Shell, Executor, Agent, and Session capabilities remain product features.
- LXD `13000` is Standalone and is outside this SaaS deployment program.

## Evidence classification

| Area | Existing evidence | Classification / required action |
|---|---|---|
| Core Session/Queue/Compact/Restart | Full Kernel/Host suites, model tests, browser matrices | Implemented; rerun after storage/auth integration |
| Single-origin Gateway/ZITADEL | Docker stack and login/logout acceptance | Implemented; rerun with real users |
| NFS Session SOT | Compose now requires NFS options | Configuration implemented; runtime NFS service/migration still blocked |
| SSO/RBAC/Viewer | Gateway tests and server-resolved SSO mapping | Partly integrated; real federation and Browser/Socket role acceptance required |
| Executor reliability | Registry/client idempotency, receipt and reconnect tests | Implemented core; real outbound Executor acceptance required |
| Provider Catalog | Runtime Provider Catalog and client factory | Integrated in Runtime Host; customer credential/CA live acceptance required |
| OpenBao/S3/Zammad/GlitchTip | Ports/adapters and contract tests | Adapter-level only; not complete until deployed/configured and exercised |
| Usage/Audit/Retention/Service Account/Webhook | PostgreSQL schema/services | Backend seams exist; HTTP/UI/worker wiring and migrations must be proven |
| Admin Center | Basic organization/member page | Incomplete for the full enterprise matrix |
| Supply chain scanners | User explicitly removed Syft/Grype/Trivy/Cosign requirement | Excluded from scope; do not block release |

## Release rule

No node may be completed from file existence or isolated unit tests alone. Final SaaS deployment requires an actual NFS mount with migrated data, real Docker health, authenticated browser tasks, cross-tenant rejection, Executor task execution, and post-restart Session recovery.
