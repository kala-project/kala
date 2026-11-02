# Dedicated single-host lifecycle operator

The backup/restore/full-upgrade lane is a **cold**, root-operated lifecycle for either the reviewed six-service `bundled-caddy` graph or five-service `external` ingress graph, with optional observability forms of nine or eight resources respectively. It is not a live backup, an HA failover system, or an external Executor-effects reconciler. Any command/tool effect not durably acknowledged before maintenance remains **unknown** and is never replayed by these tools.

## Boundary and protected inputs

All commands take a nonblocking host lock (default `/run/kala-dedicated/lifecycle.lock` in a root-private directory), use finite timeouts, suppress resolved Compose diagnostics, and require root. Backup and restore in both ingress modes require the selected Docker endpoint to be a local Unix socket; TCP/SSH/remote contexts fail before lifecycle mutations. Bundled mode additionally constrains Caddy volume mountpoints to that daemon's reported local data root. External mode has no application-owned named volumes and does not inspect or create Caddy volumes. The threat boundary is one host: root can bypass the lock or fencing.

The Compose file, parameter file and compatibility policy must be root-owned private regular non-symlink files. The recovery root is root-owned `0700`; its private installation/key files may belong to the unprivileged container UID so the actual application can read them. Initialization secret inputs remain separate root-owned files. The operator supplies one curated private `--recovery-root`; it must contain the complete material needed to reconstruct the installation, including every non-data bind source, not merely copies with matching filenames:

- the published Compose and parameter inputs/configuration;
- `deployment.json`, installation ID, and Runtime state master key;
- database/SILO credentials and initialization/Owner recovery secrets retained by local policy;
- any private application-side TLS configuration required for this installation.

In `external` mode, the external load balancer/reverse proxy's issuer, private keys, certificates and trust distribution are an independent custody boundary. They must not be copied into the application recovery root and are not backed up or restored by this operator.

Do not point this at a worktree, `$HOME`, SDK/CLI cache, Session scratch directory, or Executor workspace. The entire recovery root is archived, so it must contain neither unrelated data nor omitted out-of-tree secret symlinks. Symlinks that escape any archived root and special files are rejected.

Artifacts are SECRET. Use a dedicated root-owned `0700` parent on separately protected storage. Each artifact is first written as `<name>.incomplete`, fsynced, and atomically renamed only after `payload.tar`, `manifest.json`, and the manifest-integrity `COMPLETED` marker are durable. Existing complete or incomplete paths are never overwritten or pruned. New cold backups use **artifact schemaVersion 3**, distinct from compatibility-policy schemaVersion 1, and explicitly record `ingressMode` plus `ingressIdentityCustody`. A bundled payload contains exactly five roots (`postgres`, `silo`, `recovery`, `caddy-data`, `caddy-config`); an external payload contains exactly three (`postgres`, `silo`, `recovery`) and reports `external-not-in-app-backup`. Root omission or addition is an error. The manifest pins every regular-file SHA-256, size, UID/GID/mode, safe relative symlink, whole-payload SHA-256, all selected image digests, PostgreSQL major, installation-ID fingerprint and state-key fingerprint; bundled artifacts additionally pin both source Docker volume identities. It also binds the original parameter-file path/hash and a hash of the resolved authority credentials. A relocated target can change host paths/public origin but cannot silently substitute PG/SILO/session/shared credentials. New telemetry configurations also fingerprint the independent PG monitor password and SILO metrics JWT and cross-check them against the deployed Collector. Keep the resolved protected Compose/parameter inputs and metrics configuration in the recovery root. Old telemetry graphs without those fields require an explicit monitoring migration; they are not silently reinterpreted as the new contract, and old telemetry artifact migration is not claimed by the new-image proof. This checksum is integrity/provenance, not a signature against malicious artifact modification.

All mode-selected regular-file bytes are preserved. SILO therefore includes all object versions and IAM state under `/data`. In bundled mode only, Caddy includes its internal CA/private keys, certificates, ACME account and autosaved config from both complete named volumes. Caddy volume roots may legitimately be mode `0755`; all nested UID/GID/mode and bytes are still inventoried and restored, without relaxing the private PG/SILO/recovery-root checks or artifact secrecy. Filesystem ACLs/xattrs are not claimed or restored; deployments requiring them need a separately reviewed archive format.

## Status and cold backup

```sh
sudo ./lifecycle-status.sh --compose /secure/kala-recovery/published/docker-compose.yaml --env /secure/kala-recovery/published/.env

sudo ./backup.sh \
  --compose /secure/kala-recovery/published/docker-compose.yaml \
  --env /secure/kala-recovery/published/.env \
  --recovery-root /secure/kala-recovery \
  --installation-id-relative protected/installation_id \
  --state-key-relative protected/runtime_state_master_key \
  --artifact /offline/kala-backups/2026-10-29T0830Z
```

Prepare an **existing root-owned private (0700) backup parent directory** before invoking backup/upgrade. The operator validates this before stopping any service, and checks write-time permissions again when creating the artifact.

Backup reuses `verify-published-compose.py` and discovers the disjoint PostgreSQL/SILO bind roots. Bundled mode also proves `/data` plus `/config` are two distinct local-driver volumes declared by the exact Compose project. It cross-checks resolved declarations, Compose ownership labels, live ingress container mount metadata, Docker volume metadata, and local mountpoints, then:

1. in bundled mode, stops ingress first and verifies it is not running/restarting/paused; in external mode, requires `--acknowledge-external-ingress-fenced` and never claims that Docker can fence the external load balancer;
2. stops Gateway, Runtime, and Dashboard with a bounded graceful timeout and verifies all application writers inactive;
3. stops enabled observability resources, then PostgreSQL and SILO, verifies all services inactive, and rejects non-zero/OOM (including SIGKILL-style) data-service exits;
4. archives the exact mode-specific three or five roots without restarting anything.

For external backup, add `--acknowledge-external-ingress-fenced`. The acknowledgement must represent an independently completed external admission fence; it is required before stop or archive mutation. `status` and `upgrade-preflight` are read-only and require no such acknowledgement.

Stopping admission does **not** drain an external Executor, prove unknown commands settled, or revoke credentials outside this host. Put the installation in maintenance and handle those external contracts separately. Any error leaves services stopped or partially stopped and retains `.incomplete` evidence for operator diagnosis.

## Compatibility policy

Restore and upgrade require a separately reviewed root-owned `0600` JSON policy. There is intentionally no wildcard compatibility:

```json
{
  "schemaVersion": 1,
  "reviewId": "CHANGE-1234-reviewed-no-schema-change",
  "predecessorImages": {
    "ingress": "caddy@sha256:<64 hex>",
    "gateway": "registry/gateway@sha256:<64 hex>",
    "runtime": "registry/runtime@sha256:<64 hex>",
    "dashboard": "registry/dashboard@sha256:<64 hex>",
    "postgres": "postgres@sha256:<64 hex>",
    "silo": "pgsty/silo@sha256:<64 hex>"
  },
  "targetImages": {
    "ingress": "caddy@sha256:<64 hex>",
    "gateway": "registry/gateway@sha256:<64 hex>",
    "runtime": "registry/runtime@sha256:<64 hex>",
    "dashboard": "registry/dashboard@sha256:<64 hex>",
    "postgres": "postgres@sha256:<64 hex>",
    "silo": "pgsty/silo@sha256:<64 hex>"
  },
  "postgresMajor": "16",
  "migrationMode": "none"
}
```

The image maps must match the selected graph: bundled six, external five (no `ingress`), or either graph plus all three explicitly reviewed observability resources. Removing only part of that profile is rejected. `migrationMode` other than `none` is refused. This repository does not establish generic schema compatibility. A future migration must name and verify an existing Dedicated migration command and extend both policy and tests; arbitrary policy shell commands are never executed.

## Restore and rollback

Prepare three **existing, canonical, root-owned, mode 0700, empty, pairwise-disjoint** bind destinations. Prepare a target Compose whose data mounts are exactly those PostgreSQL/SILO destinations and whose installation ID, state key, and deployment configuration mounts are inside the recovery destination. Bundled targets must declare two **new, nonexistent, non-external local-driver** Caddy volume names for `/data` and `/config`; external targets must declare and mount no named application volumes. Target names must differ from both archived source volume names. It may use only the policy's immutable target images. Keep the old source Compose and old Caddy volumes present and stopped.

```sh
sudo ./recovery.sh \
  --source-compose /secure/source/docker-compose.yaml --source-env /secure/source.env \
  --target-compose /secure/restore/docker-compose.yaml --target-env /secure/restore.env \
  --artifact /offline/kala-backups/2026-10-29T0830Z \
  --policy /secure/compatibility.json \
  --postgres-destination /srv/kala-restore/postgres \
  --silo-destination /srv/kala-restore/silo \
  --recovery-destination /srv/kala-restore/recovery \
  --acknowledge-source-fenced \
  --create-fresh-caddy-volumes
```

Restore requires the archived, source, and target ingress modes to be identical; cross-mode restore is refused pending a separate operator cutover and trust ceremony. It verifies both source and target projects have no running/restarting/paused service, then verifies the completion marker, payload and per-file checksums, exact mode-specific root completeness, traversal/link safety, metadata inventory, predecessor/target image policy, PostgreSQL major, authority credentials, fresh bind destinations, structural target mounts, the local Docker endpoint in both modes and, in bundled mode, target Caddy volume names. In bundled mode, `--create-fresh-caddy-volumes` explicitly authorizes automatic creation of exactly those two reviewed target volumes with Compose ownership labels and a one-time freshness label; a post-create empty check closes Docker's idempotent named-volume creation race. Existing volumes, source-volume reuse, external/NFS drivers, aliases and unfamiliar mounts are refused. All feasible non-mutating preflight finishes before either volume is created or archive extraction begins. The shared topology validator must read restored bind files, so it runs as a post-extraction condition; failure leaves evidence rather than cleaning it. Extraction never overwrites and **never starts either installation**. If second-volume creation or extraction fails, any new volume or partial destination is deliberately left for diagnosis; there is no destructive cleanup. Fix by choosing entirely new empty bind destinations and new volume names, not by cleaning or overwriting the evidence.

In external mode, restore additionally requires `--acknowledge-external-ingress-fenced`, rejects `--create-fresh-caddy-volumes`, performs no TLS-key operation, and reports `ingressIdentity: external-not-restored`. The external issuer/key/certificate backup and restoration ceremony remains entirely outside this operator.

Rollback after an incompatible or ambiguous upgrade is this same cold restore into new directories (and, only for bundled mode, new Caddy volumes) and an explicit later operator cutover. Never point restore at the old roots or old volumes, and never start old and restored copies together. Credential revocation/fencing outside the Compose host remains operator work.

Artifact schemaVersion 2 remains readable as a bundled five-root artifact. Legacy artifact schemaVersion 1 is also bundled-only and contains only the three old roots and is fail-closed by default. The only supported exception is an intentional trust reset using both normal restore acknowledgements plus `--acknowledge-ingress-identity-reissue`. It still requires two fresh target Caddy volumes, reports `ingressIdentity: reissue-required-legacy-v1`, and does **not** claim preserved TLS identity. Redistribute the newly issued CA/trust before clients connect. Use bundled v2 or v3 for trust-preserving recovery. Neither old schema may be interpreted as external mode.

## Controlled no-migration upgrade

```sh
sudo ./upgrade.sh preflight \
  --current-compose /secure/current/docker-compose.yaml --current-env /secure/current.env \
  --target-compose /secure/target/docker-compose.yaml --target-env /secure/target.env \
  --policy /secure/compatibility.json

sudo ./upgrade.sh apply \
  --current-compose /secure/current/docker-compose.yaml --current-env /secure/current.env \
  --target-compose /secure/target/docker-compose.yaml --target-env /secure/target.env \
  --policy /secure/compatibility.json \
  --recovery-root /secure/kala-recovery \
  --installation-id-relative protected/installation_id \
  --state-key-relative protected/runtime_state_master_key \
  --artifact /offline/kala-backups/pre-upgrade-2026-10-29 \
  --acknowledge-maintenance-and-unknown-effects
```

Preflight requires one exact reviewed same-mode topology, reviewed immutable predecessor/target maps, unchanged PG/SILO roots, unchanged protected identity/config mounts, matching PostgreSQL major, and no migration. Bundled mode additionally requires unchanged Caddy data/config volume declarations; external mode requires no named application volumes. Apply repeats preflight, requires `--acknowledge-external-ingress-fenced` for external mode, performs the successful mode-specific cold backup first, then starts the target with bounded `docker compose up --wait`. Startup failure is reported with secrets withheld; services and the completed backup remain for diagnosis. There is no automatic rollback, data deletion, image fallback, or command replay.

## Explicitly unsupported

- live/online or multi-host-consistent backup; HA fencing against a malicious root operator;
- automatic pruning, destructive in-place restore, or simultaneous source/restored startup;
- arbitrary schema/data migration, PostgreSQL major upgrade, or unreviewed image predecessor;
- automatic draining, settling, cancellation, or replay of external Executor/provider effects;
- vendor-neutral SILO export or service-managed retention/replication proof;
- automatic credential revocation, target Compose generation, or post-restore service start.


## Independent Dashboard lane

The deployment-mode SoT distinguishes this Compose lane from the old systemd Supervisor. Dashboard-only changes must not use full `upgrade`, cold backup or ingress fencing. `lifecycle_operator.py` checks exact reviewed immutable image pairs and equality of the complete resolved graph except `services.dashboard.image`, shares the host lifecycle lock, writes a private durable receipt before mutation, and recreates only Dashboard with `--no-deps --no-build --pull never --force-recreate --wait`. Both Dashboard digests must already be locally available; this lane does not build or pull images. The existing compatibility policy must enumerate the complete predecessor/target image maps with `migrationMode: none` and the unchanged PostgreSQL major.

```bash
sudo python3 ./lifecycle_operator.py dashboard-preflight \
  --current-compose /secure/current/docker-compose.yaml --current-env /secure/current.env \
  --target-compose /secure/target/docker-compose.yaml --target-env /secure/target.env \
  --policy /secure/compatibility.json

sudo python3 ./lifecycle_operator.py dashboard-upgrade \
  --current-compose /secure/current/docker-compose.yaml --current-env /secure/current.env \
  --target-compose /secure/target/docker-compose.yaml --target-env /secure/target.env \
  --policy /secure/compatibility.json --receipt /secure/receipts/dashboard-forward.json \
  --start-timeout 120

sudo python3 ./lifecycle_operator.py dashboard-rollback \
  --source-receipt /secure/receipts/dashboard-forward.json \
  --receipt /secure/receipts/dashboard-rollback.json --start-timeout 120
```

Run from this directory. Inputs and receipts are root-private regular files; create the canonical receipt parent as root-owned mode `0700` beforehand, outside PG/SILO authority roots and the Docker data root (including Caddy volumes). Each operation requires a fresh absolute receipt path; existing evidence is never overwritten by another operation. The operation's own journal is atomically replaced and directory-fsynced through `prepared`, `applying`, and `completed` or `failed`, with a revision and phase history. The receipt contains private file paths/hashes and container continuity metadata, not resolved secrets or subprocess diagnostics. Interrupted `prepared`/`applying` is unverified, never implicit success. A receipt-write failure cannot promise a final `failed` phase; preserve its last durable phase and investigate. Root can bypass these checks; this is neither signed evidence nor malicious-root/HA fencing.

Requires Docker Compose support for `config --hash`, `--no-build`, `--pull never` and `up --wait`. Non-Dashboard containers' `com.docker.compose.config-hash` labels must match the reviewed Compose service hashes, so an edited but unapplied baseline is rejected even when image pins and authority environment remain unchanged. This does not fingerprint mutable contents behind unchanged bind paths. Non-Dashboard services must be healthy at the before/after checks, with identical container IDs, PIDs, image references/IDs, configuration hashes, start times, restart counts, OOM/exit and health state. A completed observability-readiness job may remain exited successfully. These are boundary snapshots, not proof against every transient internal-process or network fault. Failure retains normalized `dashboard_operation_unverified` when journal storage remains writable; no automatic rollback or full-stack restart is allowed. Explicit rollback binds the original frozen config/env/policy paths and SHA-256 values and the predecessor image, tolerates a failed/missing Dashboard, and requires a separate receipt. Do not edit or delete those frozen files while rollback may be needed. After publication, subsequent status/backup/full-upgrade operations must use the actually active target Compose/env; after a successful rollback, use the predecessor inputs.

Controlled Docker protocol acceptance is opt-in: `sudo env KALA_RUN_DASHBOARD_DOCKER=1 python3 -m unittest dashboard_operator_test.DashboardAdmissionTests dashboard_operator_test.DashboardDockerProtocolTests`. It uses only pre-existing local Node-image digests, a random disposable five-service project and a loopback-only random ingress port. Its services are controlled Node recipients, **not** real PG/SILO/Runtime, the production UI, Owner, Agent or Executor. It verifies actual Compose mutations, HTTP generation changes, a retained upgraded bidirectional connection, frozen-input rejection, failed-target recovery including absence, and detection of a non-Dashboard restart. No build/pull/prune or production deployment is performed. This does not certify front/back protocol compatibility, zero interruption of static HTTP, real business continuation, the latest full image set or a signed release.

## Reviewed control-schema 7→9 cold lane

This is separate from both ordinary `upgrade` (still `migrationMode: none`) and the independent Dashboard lane. It allows **only Gateway/Dashboard image changes**, with identical resolved project/configuration, Runtime/data/observability image pins, authority credentials and protected bind paths. It does not migrate Runtime storage, change PostgreSQL major, rotate credentials or accept an arbitrary source version. All images must be locally available. The target Gateway image must contain `dist/src/bin/control-schema-upgrade.js` and the complete reviewed nine-migration chain; an old schema-7 image cannot stand in for it.

The root-private policy is version **2**, with exactly `schemaVersion`, `reviewId`, `predecessorImages`, `targetImages`, `postgresMajor` (integer), `migrationMode: "control-plane-7-to-9"`, and `controlSchema`. The latter contains exactly `fromVersion: 7`, `toVersion: 9`, `writerRole: "kala_gateway"`, and `migrations`: all nine objects `{version, name, checksum}` from the packaged image, in order. Review both complete image maps and SQL changes. To inspect the target bundle without connecting to any database:

```bash
sudo docker run --rm --pull=never --network=none --memory=256m --cpus=0.5 \
  --entrypoint /nodejs/bin/node --workdir /app/packages/runtime-ingress-gateway \
  'YOUR-REVIEWED-GATEWAY@sha256:YOUR-DIGEST' \
  dist/src/bin/control-schema-upgrade.js --describe
```

This output is inspection material, not automatic compatibility approval. The operator compares it with the explicit policy and checks the **existing source's full version/name/checksum prefix**. Source version 8, version 9, missing/tampered history, wrong installation/checkpoint, wrong PostgreSQL major, a non-owner or globally privileged migration identity are refused. The existing original `kala_control_owner@postgres:5432/runlab_control` credential is required; the process never creates a database, global role or Owner.

All Compose/env/policy inputs and the original control-owner URL must be under the protected recovery root so the cold backup includes them. Keep those frozen files, the installation ID, state key and descriptor unchanged. Prepare a separate existing root-owned `0700` receipt parent outside PG/SILO, recovery and Docker data roots; prepare a private backup parent outside archived roots. Do not mount the entire initialization-secret directory in the migration job.

```bash
sudo python3 ./lifecycle_operator.py control-upgrade-preflight \
  --current-compose /secure/recovery/current.yaml --current-env /secure/recovery/current.env \
  --target-compose /secure/recovery/target.yaml --target-env /secure/recovery/target.env \
  --policy /secure/recovery/control-upgrade.json --recovery-root /secure/recovery \
  --control-owner-url /secure/recovery/init-secrets/control_owner_url

sudo python3 ./lifecycle_operator.py control-upgrade \
  --current-compose /secure/recovery/current.yaml --current-env /secure/recovery/current.env \
  --target-compose /secure/recovery/target.yaml --target-env /secure/recovery/target.env \
  --policy /secure/recovery/control-upgrade.json --recovery-root /secure/recovery \
  --control-owner-url /secure/recovery/init-secrets/control_owner_url \
  --installation-id-relative protected/installation_id --state-key-relative protected/runtime_state_master_key \
  --artifact /offline/backups/before-control-9 --receipt /secure/receipts/control-upgrade.json \
  --acknowledge-maintenance-and-unknown-effects --acknowledge-external-control-writers-fenced \
  --acknowledge-external-ingress-fenced
```

The external-writers acknowledgement covers workers, maintenance processes and other clients **outside the reviewed graph**; the operator itself stops all graph writers and observability before backup. External mode additionally requires admission to remain fenced at its independent proxy. The SQL transaction rejects any other control-database backend still present; close exporters/admin shells too. This is a conservative boundary check, not a replacement for fencing or malicious-root/HA protection.

The journal is durable before fencing and progresses through backup, migration and target startup. A complete mode-specific PG/SILO/recovery (and bundled Caddy) backup is validated before only PostgreSQL restarts. A separate bounded migration container receives exactly three read-only file mounts (policy, owner URL, installation ID), no Runtime/S3/session credentials and no published port. It has a read-only root, 256 MiB/0.5 CPU/64 PID limits, bounded logs, no-new-privileges and only `DAC_OVERRIDE` to read original container-UID-owned protected identity files. SQL changes and Gateway grants share one transaction and migration advisory lock. The running Gateway loses migration-history writes as well as governance/Outbox mutation rights. Legacy unresolved Outbox events become `legacy_review`, never automatic replay; invalid existing attribution is rejected, not silently deleted or rewritten.

Only confirmed commit plus durable `migration_committed` allows target startup. A target startup/check failure triggers a bounded stop of application/ingress containers; a failed stop records `failureFence: unverified` and requires immediate operator fencing. Migration-container/daemon disconnection, process interruption, a missing success result or journal-write failure leaves an **unverified** operation. `migrationResult: unknown` remains unknown even if the retained container exited zero; inspect the original receipt, container and database with the matching release. Never rerun migrations, start a schema-7 binary against schema 9 or assume an interrupted phase succeeded. This lane does not automatically retry, roll back SQL, clear uncertain external effects or replay commands. A receipt-storage failure can prevent final failure recording; preserve the last durable phase and actual container state.

### Explicit original-predecessor recovery

Use `control-upgrade-recover`, not reverse SQL. First fence the actual source and stop its complete graph (including any retained active migrator); keep external ingress fenced. The command binds the original upgrade receipt, its unchanged frozen inputs and verified original backup manifest. Its separate version-1 `migrationMode: none` recovery policy must set **both** image maps to the original predecessor map and retain the original PG major. The command separately rejects a retained running/created migration container; stopping Compose alone does not fence that outside process. The prepared target Compose must name a different project, use managed networks disjoint from the source networks (no external/shared source migration network), and point to three existing private **empty** destinations; bundled mode additionally requires fresh Caddy volume declarations and `--create-fresh-caddy-volumes`. Target identity/config binds must point inside the restored recovery root.

```bash
sudo python3 ./lifecycle_operator.py control-upgrade-recover \
  --source-receipt /secure/receipts/control-upgrade.json --receipt /secure/receipts/control-recovery.json \
  --target-compose /secure/restore-target.yaml --target-env /secure/restore-target.env \
  --policy /secure/predecessor-recovery.json \
  --postgres-destination /restore/pg --silo-destination /restore/silo --recovery-destination /restore/recovery \
  --acknowledge-source-fenced --acknowledge-external-ingress-fenced
```

Success is `completed_stopped`, never automatic application startup or admission reopening. Validate the restored predecessor's schema/claims/Owner/S3 and reconcile any external effects and post-backup writes before deliberate bounded startup/cutover. No automatic cleanup or in-place overwrite occurs on failure. Original frozen files must still be available at their recorded paths; missing/edited inputs or a lost source host require a separately reviewed generic artifact-recovery ceremony, not a bypass of receipt binding. Preserve remote Executor receipt journals independently.

The opt-in `control_upgrade_test.ControlUpgradeDockerTests` requires `KALA_RUN_CONTROL_UPGRADE_DOCKER=1` and a locally prepared current `KALA_SCHEMA_CANDIDATE_IMAGE` immutable digest. It uses real PG/SILO, existing initialization/claim/Owner CLIs and actual candidate migration code. Application servers are protocol fixtures with schema-aware health, **not real Runtime/Gateway HTTP, Dashboard, model or Executor business acceptance**. It makes no production deployment or signed/cross-platform release claim.
