# Dedicated Aspire new-installation evaluation

This directory supplies a runnable, isolated new-installation AppHost evaluation, not a signed or supported production Dedicated release. It does not replace or upgrade `deploy/dedicated-systemd` or `deploy/private-cloud`, and it is deliberately not a self-deployer.

The AppHost models:

- one public HTTPS `ingress` (Caddy), forwarding HTTP/WebSocket traffic to a private `gateway`;
- one private Gateway, one private Runtime, and one independently replaceable Dashboard;
- same-host PostgreSQL and PGSTY SILO, with no published host ports;
- PostgreSQL and SILO authority in operator-owned absolute host bind mounts, outside Compose volume deletion;
- immutable `name@sha256:digest` image references, supplied by the outside deployer;
- Docker Compose publication through Aspire 13.6.3's `Aspire.Hosting.Docker` integration; its diagnostic Dashboard is disabled in published Compose.

## Publishing shape

The official Aspire workflow is `aspire publish`, which generates `aspire-output/docker-compose.yaml` and a parameterized `.env`. The isolated acceptance run used .NET 10/Aspire CLI 13.6.3 and six locally cached `name@sha256` images to publish and start Compose in a fresh LXC; only `ingress` exposed port `443:443`. A later independent 4443/4444 run passed the real Copilot/Executor/S3 and stopped-writer coordinated-recovery subset described in the [evidence ledger](../../docs/architecture/three-mode-aspire-migration-plan.tmp.md). The Linux-only Runtime image is an unsigned test artifact, not an accepted cross-platform release. Aspire's publish process replaces absolute bind-mount paths with `.env` placeholders; verify all paths, permissions, values and secrets before any deployment.

Before publishing, the outside deployer must provide:

- immutable digest references in `KALA_EDGE_IMAGE`, `KALA_GATEWAY_IMAGE`, `KALA_RUNTIME_IMAGE`, `KALA_DASHBOARD_IMAGE`, `KALA_POSTGRES_IMAGE`, and `KALA_SILO_IMAGE` (`docker.io/pgsty/silo@sha256:...`, not the retired `pgsty/minio` image);
- `KALA_PUBLIC_HOSTNAME`, `KALA_PUBLIC_ORIGIN`, and optionally `KALA_PUBLIC_PORT` (default `443`); `KALA_RUNTIME_LLM_MODEL` and `KALA_RUNTIME_LLM_BASE_URL` must identify a real supported LLM service when running Agent turns (a placeholder only allows infrastructure startup, not Agent E2E);
- existing absolute `KALA_POSTGRES_DATA_DIR` and `KALA_SILO_DATA_DIR` canonical, non-symlink, disjoint directories (neither root nor nested) with ownership and permissions suitable for the selected pinned images;
- existing absolute `KALA_RUNTIME_STATE_MASTER_KEY_FILE` and `KALA_INSTALLATION_ID_FILE` paths readable by the Runtime container user; the UUID must match claims in Runtime PostgreSQL and SILO and the key fingerprint must match the coordinated recovery checkpoint; this subset does not provision any of them;
- values for every Aspire parameter emitted to the generated `.env`, including separate Gateway/control, Runtime/writer, and Runtime/Gateway-reader PostgreSQL URLs, shared/session secrets, SILO root and bucket-scoped Runtime credentials, and an LLM key. New Dedicated does **not** require OIDC. The Runtime reader must be a distinct SELECT-only principal that passes the Gateway's effective-privilege audit.

Review generated Compose before an outside terminal or CI system deploys it. Run `python3 verify-published-compose.py <docker-compose.yaml> <.env>` (with Docker Compose available) after filling the protected bind-mount paths: it rejects the unfilled paths, extra services, public data ports and application-data mounts without printing resolved secrets. In particular, verify that only `ingress` has `ports`, no Aspire debug/dashboard service appears, all six images retain accepted immutable digests, and both authority mounts point at the intended new installation. This static topology gate cannot attest image digest provenance, role/bucket policy, credential strength or recoverability.

## Isolated Linux x64 image acceptance

`Dockerfile.runtime-linux-e2e` builds the real Runtime/Executor packages and the CJS-only release assets without fabricating missing Windows native Executor files. It runs the standard unsigned release-asset verifier; its resulting image is **Linux x64 test-only**, not a signed or cross-platform release. The AppHost serves its verified `/app/release` assets for public Executor installation requests; that read-only installer route is separate from Dedicated's single authority-bearing Unit. Gateway and Dashboard use their existing Private Cloud image Dockerfiles. A locally built image ID can be used by a separately reviewed, isolated test override, but it is not a registry digest and must never be substituted for the AppHost's immutable `name@sha256` release-image contract. No image is published or pushed by these instructions.

For a clean, gitless **test-image** context, export a committed snapshot and the existing release builder's tracked-docs manifest together. Do not copy the working directory, `node_modules`, local captures or Session data:

```bash
revision=$(git rev-parse HEAD)
context=$(mktemp -d)
git archive "$revision" | tar -xf - -C "$context"
git ls-tree -rz --name-only "$revision" -- docs/ > "$context/docs/.tracked-release-docs"
# Build using the Dockerfile and files inside "$context", with SOURCE_REVISION="$revision".
# Supply RELEASE_TAG matching package.json’s product version and RELEASE_REPOSITORY explicitly; retain the normal unsigned asset verifier.
```

The one-shot SILO provisioning job retains a read-only root, dropped capabilities, no-new-privileges and a bounded 256 MiB budget with `GOMEMLIMIT=128MiB`; the former 128 MiB limit caused a real OOM during policy attachment on the pinned image. This is a provisioning-client budget, not server capacity sizing.

This intentionally excludes uncommitted changes. The manifest is Git-derived and NUL-delimited; never replace it with a directory walk to bypass the release builder's privacy boundary. Clean Runtime/Dashboard builders use a bounded five-minute `PNPM_FETCH_TIMEOUT` (milliseconds; override only as a reviewed build argument) for large editor/diagram packages. This changes neither frozen-lockfile integrity nor TLS verification, and is unrelated to the five-second runtime secret-resolution deadline. These steps produce local test images, not signed supported releases.

## Fresh single-host initialization

`initialize.sh` is the only modeled path from empty PG/SILO authority to the six running services. Do not run `docker compose up` first. The script rejects running application containers, runs the static topology gate, compares resolved Compose credentials to protected files without printing values, starts only PostgreSQL and SILO, then performs:

1. fail-closed PostgreSQL provisioning with an installation marker in the maintenance database, separate `runlab_control` and `kala_runtime` databases, and fixed owner/writer/reader roles;
2. `kala-runtime` bucket creation, versioning, anonymous-access denial, and a bucket-only Runtime policy through a separate one-shot container with a reviewed immutable mc-capable image (the pinned PGSTY SILO image includes its matching `mc` client);
3. the real `kala-fresh-storage-claim` CLI, which claims empty control PG, Runtime PG, and SILO and creates the initial coordinated recovery checkpoint;
4. the real Gateway control-plane initializer and `kala-postgres-migrate`, granting DML to Runtime and only the reviewed query tables to Gateway's distinct Runtime reader;
5. the real `bootstrap-dedicated-owner` CLI; only after it succeeds are application services started.

Run `initialize.sh` as the root operator. Create a root-owned directory with mode `0700`; every file below must also be **root-owned**, regular, non-symlink and mode `0600`. The capability-restricted provisioning job cannot read another UID’s private files, even when its container user is zero; ownership/permissions are checked before mutation:

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

Use `--initialize-only` as the fourth argument to leave applications stopped after successful Owner bootstrap. PG provisioning, SILO provisioning, storage claim verification, and migrations are retryable for the same installation ID. Partial cross-authority claims deliberately block automatic retry and require investigation. Owner bootstrap is transactional but intentionally non-idempotent. If its result is ambiguous or it reports an existing Owner, do not reset credentials or rerun it as an implicit success. With application containers stopped, the same reviewed configuration and protected original Owner password, explicitly use `--resume-initialized` as the fourth argument. This skips PG/SILO provisioning, claims, migrations and Owner creation; the real Gateway CLI `bootstrap-dedicated-owner --verify-existing` checks the current schema version, one expected active Organization, canonical Owner principal, active Owner membership/contract, expected organization name/optional email, and the original scrypt password. Successful verification records only the normal authentication timestamp, never a new password/verifier. Missing/mismatched/disabled authority denies continuation. Runtime/Gateway startup retain installation/checkpoint/state-key checks. This is safe continuation with a known credential, not lost-password recovery or an upgrade command. The initialized checkpoint only proves the three authorities and state-key fingerprint agree; it is **not** a backup, restore test, or accepted recovery point.

### Bounded startup and restart

Republish with the current AppHost before using the updated initializer. All six services now have executable Compose health checks (5-second interval, 4-second timeout, 12 retries, 20-second start period) and `unless-stopped` restart policy. The topology gate rejects missing/disabled probes and missing, symlink/alias, equal or nested authority roots **before mutation**. `initialize.sh` treats running, restarting or paused application containers as active writers; a failed inspection does not mean stopped. It waits for PG/SILO health before initialization/verification and uses `docker compose up -d --wait --wait-timeout` before reporting a healthy application graph. Requires a Compose version supporting these flags. `KALA_ASPIRE_START_TIMEOUT_SECONDS` is an explicit 1–900-second bound, default 180.

Runtime's probe uses the existing internal service credential and requires state `ready`, so a draining Runtime is not healthy. Gateway/Dashboard use their health endpoints; the Gateway probe uses native HTTP with the configured public Host (Node fetch does not preserve that override here), so the public Host allowlist is not relaxed; PG uses `pg_isready`; SILO uses its readiness endpoint. Caddy has a **container-loopback-only** HTTP liveness listener on 8081; it is not published, does not disable certificate checks or replace the public HTTPS path. These probes are process/graph health, not proof of real Agent work, ongoing database/object authorization, public TLS or a complete transaction. Initialization/Owner and application claim/schema gates remain separate requirements.

On timeout/failure, the script returns nonzero and does not print readiness success. Containers and data are left intact for inspection; it does not prune, reset claims or automatically roll back unknown work. Stop/isolate application writers before an explicit continuation. After a successful install, ordinary restarts do not rerun bootstrap; use the same verified Compose graph and bounded `up --wait`. Do not use `--resume-initialized` to bypass a version upgrade/migration or recover an unknown password.

## Known omissions and blockers

This is a runnable **experimental single-host installation**, not a supported Dedicated release. Fresh PG/SILO provisioning, three-authority claims, schema 7, Owner login, real Copilot/Executor tool execution and the isolated coordinated cold-recovery subset have passed (see below). A supported cross-platform release and complete production lifecycle have not passed. Remaining boundaries are:

1. **Owner password rotation/lost-password recovery remains absent.** Fresh initialization installs the Dedicated Owner from a protected password file and empty organization catalog. Password rotation and lost-password recovery are not implemented. Explicit known-password verification/continuation now handles an already-committed bootstrap; it cannot recover unknown credentials.
2. **Initialization is an external operator transaction, not an Aspire startup resource.** `initialize.sh` enforces health/claim/schema/Owner ordering, while ordinary generated Compose still contains exactly six services. Bypassing it is unsupported; application claim and schema checks fail closed but cannot prove the operator followed the whole ceremony.
3. **SILO acceptance remains limited.** Initialization creates a versioned private bucket and bucket-scoped identity and the real claim exercises listing/version listing/conditional marker creation. The cold-restore drill additionally preserved object versions and tested replacement credentials with former identities rejected. Licensing, retention/object-lock policy, full multipart compatibility, online rotation and fault-injected partial-claim recovery remain unverified.
4. **Security hardening is incomplete.** Generated services have not yet been augmented with read-only roots, tmpfs, dropped capabilities, resource limits, log limits, or private/internal network partitioning. The experimental unprivileged Runtime uses image-overlay scratch owned by its UID; PG/S3, not this scratch, must be the only durable authority. `WaitFor` still expresses model ordering, not migration readiness; explicit Compose probes/wait now add graph-health gating, not complete application acceptance. Aspire build currently emits `ASPIRE010` because this AppHost does not opt into the CLI bundle; publication succeeded with a matching temporary CLI, but supported long-term toolchain pinning is pending.
5. **Production TLS is unverified.** Isolated `localhost` Caddy issued a local CA certificate and served HTTPS; publicly trusted ACME issuance, DNS and renewal were not tested.
6. **Supported images are not supplied.** Locally built unsigned Linux acceptance images do not substitute for a provenance-verified Kala release and an accepted SILO digest. Successful marker/checkpoint conditional writes and an offline whole-tree restore are only the recorded subsets, not acceptance of all SILO compatibility, backup retention, licensing, multipart or failure modes.
7. **No complete deployment lifecycle exists.** Automated drain/admission handling, external upgrade/rollback, backup/restore orchestration, online secret rotation, observability and full three-mode production acceptance are outside this subset; the cold operator drill does not implement those products. There is intentionally no Supervisor, blue/green pair, or Runtime self-deploy path.

Do not run `docker compose down -v`, broad prune commands, or any legacy migration against these paths. Remaining release, hardening and lifecycle gates require their own isolated acceptance; the cold restore already recorded below is not a blanket sign-off.

## Verified recovery boundary

The latest isolated acceptance used the actual operator initialization, schema 7 and a real organization-invited Executor over CA-verified HTTPS. It stopped application writers, advanced the existing three-authority checkpoint, backed up control/Runtime PG plus the entire stopped SILO data tree and protected state key, and restored to independent directories. Replacement PG/S3 workload credentials rejected the old credentials; wrong-key startup was refused. Real SDK model memory resumed without the original application-node scratch, the artifact hash survived, and the original external device reconnected and executed another real tool call.

This is a **cold, operator-controlled recovery subset**, not an automated backup/restore command, a production HA claim, a supported upgrade/rollback decision or a guarantee about arbitrary in-flight effects. The external Executor workspace/device identity and provider credentials have separate recovery contracts. SILO needs adequate real free space: a genuine 507 low-watermark failure was preserved in the evidence; do not delete partial installation markers or lower storage safety thresholds to make initialization appear successful. The tiny persistent loop-backed filesystems used in that drill are test infrastructure, not deployment sizing guidance. See the evidence ledger for exact image/revision, credential boundaries and remaining gates.

## Current-source initialization acceptance (2026-10-29)

The [bounded evidence record](../../docs/evidence/evaluation/dedicated-aspire-initialization-20261029.json) binds application images built from `c948fe30` to the corrected external AppHost/initialization scripts at `d2afae3c`. Application code is unchanged by the later operator-only corrections. Official .NET SDK 10.0.403/Aspire CLI 13.6.3 built and published the actual model. The six Docker-registered OCI digests are recorded; they are unsigned local test artifacts, not registry-provenance or release certification.

The real isolated run rejects unsafe input ownership before creating any container; initializes fresh PG/SILO/claims/schema/Owner with only authorities left running; refuses wrong-password continuation; starts all six healthy services with the original identity; and passes CA-verified HTTPS Owner login. A wrong 32-byte state key causes Runtime checkpoint rejection and a nonzero startup result with no readiness success. Restoring the original key permits explicit continuation without reinitialization, and the same opaque Owner login session remains usable after application restart. The fixture used only synthetic credentials/state and no Agent business Session. All its containers, networks and project-specific Caddy volumes were removed.

The same drill preserved a real provisioning-client OOM and showed that a raw-loopback/fetch Gateway probe is rejected by the existing Host policy; native HTTP with the configured public Host succeeds. The limits/probe are fixed without disabling capability, TLS, Host or release-asset checks. Local CA read permissions were corrected in the client fixture, not bypassed. Gateway Owner tests passed 8 cases (including real PG/committed-child SIGKILL), topology 2, existing release/privacy regressions 22; actual AppHost build passed with the known ASPIRE010 warning retained. This new initialization slice does not inherit the older real SDK/Executor acceptance as evidence for these images. The remaining backup/restore, upgrade/rollback, lost-password, public TLS, hardening and release gates above stay open.
