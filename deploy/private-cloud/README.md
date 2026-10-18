# Kala Private Cloud

Public installations use the versioned release bundle and its `kala-private-cloud`
operator. Start with the [signed-bundle first-install guide](../../docs/operations/private-cloud-first-install.md),
then consult [release and lifecycle details](../../docs/operations/private-cloud-release.md).
No source checkout or local application build is part of the supported production workflow.

The commands below are repository development and acceptance workflows only. They
add `compose.dev.yaml`, which supplies local source builds over the production
topology.

The default **release candidate** uses bundled ZITADEL in the **same Compose project** as the three Kala application images and publishes only localhost HTTP endpoints. The installer checks both ports and chooses a different free localhost pair before saving configuration when the defaults are occupied; it does not touch an existing service on `13001`. The default local NFS port is checked separately (`12049`, falling back to `12149/12249`), and a Docker-valid storage subnet is used; `--storage local-volume` is an explicit alternative, not an automatic durability downgrade. For existing OIDC, select the app port before registering its redirect URI; it will not be changed automatically. The signed-bundle guide describes the single `setup` entry point and the alternative existing-OIDC mode. Cloudflare Tunnel is not part of Kala installation; publishing remotely requires a separate HTTPS identity-address migration, not just forwarding one port.

The source-only shared Identity service below is a separate **development** Compose project, not a prerequisite for the bundled production flow. No credential values belong in Git; only `*.env.example` metadata files are tracked. For this development path, start and verify Identity first; Private Cloud consumes it as an OIDC client.

Profiles:

- `local`: loopback HTTP, Docker NFS-Ganesha storage.
- `cloudflare`: private deployment origins supplied through the ignored environment, Docker NFS-Ganesha.
- `acceptance`: local topology plus mock LLM.
- `local-volume`: development-only Docker local volume.
- `external-nfs`: Cloudflare profile with an operator-supplied NFS endpoint.

```bash
docker compose --env-file deploy/identity/.secrets/deployment.env \
  -f deploy/identity/compose.yaml up -d --wait
pnpm private-cloud:secrets
KALA_PROFILE=cloudflare pnpm private-cloud:check
KALA_PROFILE=cloudflare pnpm private-cloud:deploy
```

The Platform Dashboard is a separate immutable container image behind Runtime Ingress. A
Dashboard-only release rebuilds and replaces only `dashboard`; it does not restart
`runtime-host`, change Unit ownership, interrupt Executor sockets, or run Session
continuation. Runtime and Dashboard image identities must both be captured in the private
release manifest. Portable remains the sole distribution that embeds Dashboard assets in
the Runtime executable.

```bash
KALA_PROFILE=cloudflare pnpm private-cloud:deploy-dashboard
```

Cloudflare Tunnel routes:

```yaml
ingress:
  - hostname: <runlab-domain>
    service: http://127.0.0.1:13001
  - hostname: <identity-domain>
    service: http://127.0.0.1:13002
  - service: http_status:404
```

Do not put Cloudflare credentials, OIDC secrets, API keys, passwords, `.env` files, backups,
or generated release manifests into Git. Public hostnames in profile files are not secrets.
The default production storage remains the NFS server in the same Docker Compose project.

Gateway-to-Runtime traffic uses TLS 1.3 with mutually authenticated certificates generated
by `private-cloud:secrets`. The Runtime listener rejects clients without a certificate signed
by the installation-local internal CA; the existing ingress secret remains a second,
application-layer authorization boundary.

Per-Unit concurrency, durable queue length, and artifact storage limits are configurable with
`KALA_RUNTIME_UNIT_MAX_CONCURRENT_TURNS`, `KALA_RUNTIME_UNIT_MAX_QUEUED_MESSAGES`, and
`KALA_RUNTIME_UNIT_MAX_ARTIFACT_BYTES`.

The versioned Product API is served at `/api/v1`; its OpenAPI document is
`/api/v1/openapi.json`. Browser Sessions and organization-scoped Service Accounts are
supported. Service Account tokens are shown once, stored only as hashes, and bounded by
`KALA_INGRESS_MAX_SERVICE_ACCOUNTS`. See `docs/reference/api/v1.md`.

For an operator-controlled Unit transfer, stop `runtime-host`, export or restore the named
Unit, then restart it. Restore verifies the manifest and archive digest and refuses to
overwrite an existing Unit:

```bash
pnpm private-cloud:export-unit -- <unit-id> <persistent-backup-directory>
pnpm private-cloud:restore-unit -- <persistent-export-directory>
```

## Operational hardening

All long-running services use bounded `json-file` logs and drop Linux capabilities.
Run `KALA_PROFILE=cloudflare node scripts/private-cloud-local/health-report.mjs` from monitoring.
Alert on non-zero exit, less than 5 GiB free space, unhealthy containers, PostgreSQL backup
failure, or NFS health failure. Runtime egress is intentionally isolated on the `egress`
network; enforce destination-level policy at the host firewall or an egress proxy. Production
release automation should resolve mutable application image names to the IDs captured in the
ignored local release manifest before promotion.
