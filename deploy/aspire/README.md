# Dedicated Aspire subset (not a runnable Dedicated release)

This directory is an isolated, new-installation AppHost experiment. It does not replace or upgrade `deploy/dedicated-systemd` or `deploy/private-cloud`, and it is deliberately not a self-deployer.

The AppHost models:

- one public HTTPS `ingress` (Caddy), forwarding HTTP/WebSocket traffic to a private `gateway`;
- one private Gateway, one private Runtime, and one independently replaceable Dashboard;
- same-host PostgreSQL and PGSTY SILO, with no published host ports;
- PostgreSQL and SILO authority in operator-owned absolute host bind mounts, outside Compose volume deletion;
- immutable `name@sha256:digest` image references, supplied by the outside deployer;
- Docker Compose publication through Aspire 13.6.3's `Aspire.Hosting.Docker` integration; its diagnostic Dashboard is disabled in published Compose.

## Publishing shape

The official Aspire workflow is `aspire publish`, which generates `aspire-output/docker-compose.yaml` and a parameterized `.env`. The isolated acceptance run used .NET 10/Aspire CLI 13.6.3 and six locally cached `name@sha256` images to publish and start Compose in a fresh LXC; only `ingress` exposed port `443:443`. The Linux-only Runtime image is an unsigned test artifact, not an accepted cross-platform release. Aspire's publish process replaces absolute bind-mount paths with `.env` placeholders; verify all paths, permissions, values and secrets before any deployment.

Before publishing, the outside deployer must provide:

- immutable digest references in `KALA_EDGE_IMAGE`, `KALA_GATEWAY_IMAGE`, `KALA_RUNTIME_IMAGE`, `KALA_DASHBOARD_IMAGE`, `KALA_POSTGRES_IMAGE`, and `KALA_SILO_IMAGE` (`docker.io/pgsty/silo@sha256:...`, not the retired `pgsty/minio` image);
- `KALA_PUBLIC_HOSTNAME`, `KALA_PUBLIC_ORIGIN`, and optionally `KALA_PUBLIC_PORT` (default `443`); `KALA_RUNTIME_LLM_MODEL` and `KALA_RUNTIME_LLM_BASE_URL` must identify a real supported LLM service when running Agent turns (a placeholder only allows infrastructure startup, not Agent E2E);
- existing absolute `KALA_POSTGRES_DATA_DIR` and `KALA_SILO_DATA_DIR` paths with ownership and permissions suitable for the selected pinned images;
- existing absolute `KALA_RUNTIME_STATE_MASTER_KEY_FILE` and `KALA_INSTALLATION_ID_FILE` paths readable by the Runtime container user; the UUID must match claims in Runtime PostgreSQL and SILO and the key fingerprint must match the coordinated recovery checkpoint; this subset does not provision any of them;
- values for every Aspire parameter emitted to the generated `.env`, including separate Gateway/control, Runtime/writer, and Runtime/Gateway-reader PostgreSQL URLs, shared/session secrets, SILO root and bucket-scoped Runtime credentials, and an LLM key. New Dedicated does **not** require OIDC. The Runtime reader must be a distinct SELECT-only principal that passes the Gateway's effective-privilege audit.

Review generated Compose before an outside terminal or CI system deploys it. Run `python3 verify-published-compose.py <docker-compose.yaml> <.env>` (with Docker Compose available) after filling the protected bind-mount paths: it rejects the unfilled paths, extra services, public data ports and application-data mounts without printing resolved secrets. In particular, verify that only `ingress` has `ports`, no Aspire debug/dashboard service appears, all six images retain accepted immutable digests, and both authority mounts point at the intended new installation. This static topology gate cannot attest image digest provenance, role/bucket policy, credential strength or recoverability.

## Isolated Linux x64 image acceptance

`Dockerfile.runtime-linux-e2e` builds the real Runtime/Executor packages and the CJS-only release assets without fabricating missing Windows native Executor files. It runs the standard unsigned release-asset verifier; its resulting image is **Linux x64 test-only**, not a signed or cross-platform release. The AppHost serves its verified `/app/release` assets for public Executor installation requests; that read-only installer route is separate from Dedicated's single authority-bearing Unit. Gateway and Dashboard use their existing Private Cloud image Dockerfiles. A locally built image ID can be used by a separately reviewed, isolated test override, but it is not a registry digest and must never be substituted for the AppHost's immutable `name@sha256` release-image contract. No image is published or pushed by these instructions.

## Fresh single-host initialization

`initialize.sh` is the only modeled path from empty PG/SILO authority to the six running services. Do not run `docker compose up` first. The script rejects running application containers, runs the static topology gate, compares resolved Compose credentials to protected files without printing values, starts only PostgreSQL and SILO, then performs:

1. fail-closed PostgreSQL provisioning with an installation marker in the maintenance database, separate `runlab_control` and `kala_runtime` databases, and fixed owner/writer/reader roles;
2. `kala-runtime` bucket creation, versioning, anonymous-access denial, and a bucket-only Runtime policy through a separate one-shot container with a reviewed immutable mc-capable image (the pinned PGSTY SILO image includes its matching `mc` client);
3. the real `kala-fresh-storage-claim` CLI, which claims empty control PG, Runtime PG, and SILO and creates the initial coordinated recovery checkpoint;
4. the real Gateway control-plane initializer and `kala-postgres-migrate`, granting DML to Runtime and only the reviewed query tables to Gateway's distinct Runtime reader;
5. the real `bootstrap-dedicated-owner` CLI; only after it succeeds are application services started.

Create a root-owned directory with mode `0700`; every file below must be a regular non-symlink file with mode `0600`:

| file | required content |
| --- | --- |
| `postgres_admin_url` | `postgresql://postgres:<unique-password>@postgres:5432/postgres` |
| `control_owner_url` | `postgresql://kala_control_owner:<unique-password>@postgres:5432/runlab_control` |
| `gateway_database_url` | `postgresql://kala_gateway:<unique-password>@postgres:5432/runlab_control` and exactly the published Gateway URL |
| `runtime_owner_url` | `postgresql://kala_runtime_owner:<unique-password>@postgres:5432/kala_runtime` |
| `runtime_database_url` | `postgresql://kala_runtime:<unique-password>@postgres:5432/kala_runtime` and exactly the published Runtime URL |
| `runtime_reader_database_url` | `postgresql://kala_runtime_reader:<unique-password>@postgres:5432/kala_runtime` and exactly the published Gateway reader URL |
| `silo_root_access_key`, `silo_root_secret_key` | exactly the published SILO root pair; never used by Runtime |
| `runtime_s3_access_key`, `runtime_s3_secret_key` | distinct bucket-scoped pair, exactly the published Runtime pair |
| `installation_id` | canonical UUID, identical to the published installation-ID bind mount |
| `runtime_state_master_key` | identical bytes to the published Runtime state-master-key file |
| `owner_password` | initial Dedicated Owner password (at least 14 characters) |

Percent-encode URL credentials. All six PostgreSQL passwords must differ. Set `KALA_MC_IMAGE` to a reviewed immutable mc-capable image such as the same `pgsty/silo@sha256:...` digest used by the SILO service, `KALA_DEDICATED_ORGANIZATION_NAME`, and optionally `KALA_DEDICATED_OWNER_EMAIL`, then run:

```bash
KALA_MC_IMAGE='pgsty/silo@sha256:<reviewed-digest>' \
KALA_DEDICATED_ORGANIZATION_NAME='Example' \
./initialize.sh aspire-output/docker-compose.yaml aspire-output/.env /absolute/protected/init-secrets
```

Use `--initialize-only` as the fourth argument to leave applications stopped after successful Owner bootstrap. PG provisioning, SILO provisioning, storage claim verification, and migrations are retryable for the same installation ID. Partial cross-authority claims deliberately block automatic retry and require investigation. Owner bootstrap is transactional but intentionally non-idempotent: if its result is ambiguous or it reports an existing Owner, do not reset or auto-accept it; inspect the control plane and use a separately designed password rotation/recovery procedure. The initialized checkpoint only proves the three authorities and state-key fingerprint agree; it is **not** a backup, restore test, or accepted recovery point.

## Known omissions and blockers

This is a runnable **experimental single-host installation**, not a supported Dedicated deployment or a full Agent E2E. The isolated Linux x64 image and local Compose passed fresh PG/SILO provisioning, three-authority claim verification, both schema migrations, Owner bootstrap, six-container startup, and a real Copilot SDK text-only Session plus follow-up after Gateway/Runtime restart with PG event/projection persistence. Workspace Executor tool receipts, S3 artifact durability, coordinated restore and a supported cross-platform release have not passed:

1. **Owner recovery remains absent.** Fresh initialization installs the Dedicated Owner from a protected password file and empty organization catalog. Password rotation, lost-password recovery, and an operator-safe way to resolve an ambiguous bootstrap result are not implemented or tested.
2. **Initialization is an external operator transaction, not an Aspire startup resource.** `initialize.sh` enforces health/claim/schema/Owner ordering, while ordinary generated Compose still contains exactly six services. Bypassing it is unsupported; application claim and schema checks fail closed but cannot prove the operator followed the whole ceremony.
3. **SILO acceptance remains limited.** Initialization creates a versioned private bucket and bucket-scoped identity and the real claim exercises listing/version listing/conditional marker creation. SILO licensing, retention/object-lock policy, full multipart compatibility, credential rotation/revocation, and fault-injected partial-claim recovery remain unverified.
4. **Security hardening is incomplete.** Generated services have not yet been augmented with read-only roots, tmpfs, dropped capabilities, resource limits, health checks, log limits, or private/internal network partitioning. The experimental unprivileged Runtime uses image-overlay scratch owned by its UID; PG/S3, not this scratch, must be the only durable authority. `WaitFor` expresses model ordering, not migration readiness. Aspire build currently emits `ASPIRE010` because this AppHost does not opt into the CLI bundle; publication succeeded with a matching temporary CLI, but supported long-term toolchain pinning is pending.
5. **Production TLS is unverified.** Isolated `localhost` Caddy issued a local CA certificate and served HTTPS; publicly trusted ACME issuance, DNS and renewal were not tested.
6. **Supported images are not supplied.** Locally built unsigned Linux acceptance images do not substitute for a provenance-verified Kala release and an accepted SILO digest. SILO licensing, compatibility, backup/restore, multipart, conditional requests, and failure recovery remain unverified.
7. **No complete deployment lifecycle exists.** Drain/admission handling, external upgrade/rollback, backups, restore, secret rotation, observability, and full three-mode Executor/tool end-to-end tests are outside this subset. There is intentionally no Supervisor, blue/green pair, or Runtime self-deploy path.

Do not run `docker compose down -v`, broad prune commands, or any legacy migration against these paths. A future acceptance pass needs an isolated new installation and real restore testing before this can become a Dedicated target.
