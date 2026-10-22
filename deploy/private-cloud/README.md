# Kala Private Cloud

Public installations use the versioned release bundle and its `kala-private-cloud`
operator. Start with the [signed-bundle first-install guide](../../docs/operations/private-cloud-first-install.md),
then consult [release and lifecycle details](../../docs/operations/private-cloud-release.md).
The signed-bundle workflow does not require a source checkout or local application build; the current public beta is not production-supported.

The commands below are repository development and acceptance workflows only. They
add `compose.dev.yaml`, which supplies local source builds over the release
Compose topology.

The *published legacy* installer uses bundled ZITADEL in the **same Compose project** as the three Kala application images, publishes only localhost HTTP endpoints and defaults to **single-host `local-volume`** storage. This is not the [Private Cloud deployment target](../../docs/architecture/private-cloud-enterprise-architecture-contract.md#private-cloud-persistence-and-deployment-invariant) and must not be presented as a scalable or HA customer installation. The installer checks both application ports and chooses a free localhost pair before saving configuration; it does not touch an existing service on `13001`. NFS is **not** the default or the enterprise storage target: it remains an explicit, unaccepted experimental `--storage nfs` choice. Only if that option is selected does the installer check a separate local NFS port (`12049`, falling back to `12149/12249`) and storage subnet. The default local volume still requires durable backups and is not replicated storage. For existing OIDC, select the app port before registering its redirect URI; it will not be changed automatically. The signed-bundle guide describes the single `setup` entry point and the alternative existing-OIDC mode. Cloudflare Tunnel is not part of Kala installation; publishing remotely requires a separate HTTPS identity-address migration, not just forwarding one port.

The source-only shared Identity service below is a separate **development** Compose project, not a prerequisite for the bundled legacy installer or the PG/S3 evaluation path with external OIDC. No credential values belong in Git; only `*.env.example` metadata files are tracked. For this development path, start and verify Identity first; Private Cloud consumes it as an OIDC client.

**Source-only development profiles below do not set the signed installer's default.** The legacy NFS variants remain for explicit experiments and are not the Private Cloud target:

- `local`: loopback HTTP with legacy Docker NFS-Ganesha, **not** the release default.
- `cloudflare`: private origins with legacy Docker NFS-Ganesha.
- `acceptance`: the legacy local NFS topology plus mock LLM.
- `local-volume`: source-build workflow using the same single-host storage *mode* as the signed beta's default.
- `external-nfs`: explicit legacy external NFS experiment.
- `postgres-s3`: opt-in **fresh-install evaluation** with separate externally operated control and Runtime PostgreSQL databases, external S3, PostgreSQL Gateway login state, versioned schema migrations and independent workload roles. Runtime and Gateway do not mount authoritative application-data volumes; host secret sources and other gaps remain. This is neither the supported release profile nor an in-place upgrade; read the [PG/S3 operator prerequisites and unsupported backup boundaries](../../docs/operations/private-cloud-postgres-s3-profile.md) before using it.

```bash
docker compose --env-file deploy/identity/.secrets/deployment.env \
  -f deploy/identity/compose.yaml up -d --wait
pnpm private-cloud:secrets
KALA_PROFILE=local-volume pnpm private-cloud:check
KALA_PROFILE=local-volume pnpm private-cloud:deploy
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
The signed beta's storage default is `local-volume`, not NFS. Neither the single-host volume nor the optional experimental NFS mode is the enterprise PG/S3 target; see the [design/status ledger](../../docs/architecture/private-cloud-design-status.md). This beta is not production-supported.

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
For the source-only local-volume profile, run `KALA_PROFILE=local-volume node scripts/private-cloud-local/health-report.mjs` from monitoring.
Alert on non-zero exit, less than 5 GiB free space, unhealthy containers, or PostgreSQL backup
failure; check NFS health only if an explicit experimental NFS profile is in use. Runtime egress is intentionally isolated on the `egress`
network; enforce destination-level policy at the host firewall or an egress proxy. Production
release automation should resolve mutable application image names to the IDs captured in the
ignored local release manifest before promotion.
