# Runtime Component Naming Migration

## Canonical names

Agent RunLab exposes three user-facing variants: Portable, Dedicated, and Private Cloud. Dedicated and Private Cloud share the Platform architecture and differ by `tenancy`, not by node count or ownership. Every variant is self-hosted by its user.

Technical names describe their responsibility rather than a removed product mode:

- package: `packages/runtime-ingress-gateway`, `@agent-kernel/runtime-ingress-gateway`;
- symbols: `RuntimeIngressGateway`, `startRuntimeIngressGateway`;
- binary: `kala-runtime-ingress`;
- Platform runtime: `RuntimeHost`;
- trusted selector: `RuntimeUnitIngress`;
- isolated runtime: `TenantRuntimeUnit`;
- Private Cloud environment: `KALA_INGRESS_*`, `KALA_RUNTIME_HOST_*`, `KALA_PUBLIC_LISTEN`, and `KALA_PUBLIC_URLS`;
- Dedicated services and assets: `kala-dedicated-*`, `deploy/dedicated-systemd/`, and `deploy:dedicated`;
- Private Cloud stack: `deploy/private-cloud/`, `scripts/private-cloud-local/`, and `private-cloud:*`.

## Clean cutover

Removed product-mode environment values, aliases, parsers, paths, commands, service names, protocol values, metrics, logs, and receipts are not retained. Direct execution defaults to Portable; every Platform deployment supplies the versioned deployment configuration.

Historical evidence files remain immutable and may retain their original terminology. Browser PWA `display-mode: standalone` and the independently deployable Evaluation platform are unrelated concepts and are not renamed by this migration.
