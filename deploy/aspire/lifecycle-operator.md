# Dedicated single-host lifecycle operator

This is a **cold**, root-operated lifecycle for the reviewed six-service Aspire graph or its optional nine-resource observability form. It is not a live backup, an HA failover system, or an external Executor-effects reconciler. Any command/tool effect not durably acknowledged before maintenance remains **unknown** and is never replayed by these tools.

## Boundary and protected inputs

All commands take a nonblocking host lock (default `/run/kala-dedicated/lifecycle.lock` in a root-private directory), use finite timeouts, suppress resolved Compose diagnostics, and require root. Backup and restore additionally require the selected Docker endpoint to be a local Unix socket and constrain volume mountpoints to that daemon's reported local data root; TCP/SSH/remote contexts fail before lifecycle mutations. The threat boundary is one host: root can bypass the lock or fencing.

The Compose file, parameter file and compatibility policy must be root-owned private regular non-symlink files. The recovery root is root-owned `0700`; its private installation/key files may belong to the unprivileged container UID so the actual application can read them. Initialization secret inputs remain separate root-owned files. The operator supplies one curated private `--recovery-root`; it must contain the complete material needed to reconstruct the installation, including every non-data bind source, not merely copies with matching filenames:

- the published Compose and parameter inputs/configuration;
- `deployment.json`, installation ID, and Runtime state master key;
- database/SILO credentials and initialization/Owner recovery secrets retained by local policy;
- any private TLS configuration required for this installation.

Do not point this at a worktree, `$HOME`, SDK/CLI cache, Session scratch directory, or Executor workspace. The entire recovery root is archived, so it must contain neither unrelated data nor omitted out-of-tree secret symlinks. Symlinks that escape any archived root and special files are rejected.

Artifacts are SECRET. Use a dedicated root-owned `0700` parent on separately protected storage. Each artifact is first written as `<name>.incomplete`, fsynced, and atomically renamed only after `payload.tar`, `manifest.json`, and the manifest-integrity `COMPLETED` marker are durable. Existing complete or incomplete paths are never overwritten or pruned. Cold-backup **artifact schemaVersion 2** is distinct from compatibility-policy schemaVersion 1. A v2 payload must contain exactly five complete top-level roots: `postgres`, `silo`, `recovery`, `caddy-data`, and `caddy-config`; omission is an error, never an optional feature. The manifest pins every regular-file SHA-256, size, UID/GID/mode, safe relative symlink, whole-payload SHA-256, all selected image digests, PostgreSQL major, installation-ID fingerprint, state-key fingerprint, and both source Docker volume identities. It also binds the original parameter-file path/hash and a hash of the resolved authority credentials. A relocated target can change host paths/public origin but cannot silently substitute PG/SILO/session/shared credentials. This checksum is integrity/provenance, not a signature against malicious artifact modification.

Regular-file bytes from both complete bind roots and both complete Caddy named volumes are preserved. SILO therefore includes all object versions and IAM state under `/data`; Caddy includes its internal CA/private keys, certificates, ACME account and autosaved config. Caddy volume roots may legitimately be mode `0755`; all nested UID/GID/mode and bytes are still inventoried and restored, without relaxing the private PG/SILO/recovery-root checks or artifact secrecy. Filesystem ACLs/xattrs are not claimed or restored; deployments requiring them need a separately reviewed archive format.

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

Backup reuses `verify-published-compose.py`, discovers the disjoint PostgreSQL/SILO bind roots, and proves `/data` plus `/config` are two distinct local-driver volumes declared by the exact Compose project. It cross-checks resolved declarations, Compose ownership labels, live ingress container mount metadata, Docker volume metadata, and local mountpoints, then:

1. stops ingress first and verifies it is not running/restarting/paused;
2. stops Gateway, Runtime, and Dashboard with a bounded graceful timeout and verifies all application writers inactive;
3. stops enabled observability resources, then PostgreSQL and SILO, verifies all services inactive, and rejects non-zero/OOM (including SIGKILL-style) data-service exits;
4. archives PostgreSQL, SILO, the curated recovery root, and complete Caddy `/data` plus `/config` volume roots without restarting anything.

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

For an enabled observability profile, both image maps must include the three explicitly reviewed additional resource names as well. Removing only part of that profile is rejected. `migrationMode` other than `none` is refused. This repository does not establish generic schema compatibility. A future migration must name and verify an existing Dedicated migration command and extend both policy and tests; arbitrary policy shell commands are never executed.

## Restore and rollback

Prepare three **existing, canonical, root-owned, mode 0700, empty, pairwise-disjoint** bind destinations. Prepare a target Compose whose data mounts are exactly those PostgreSQL/SILO destinations, whose installation ID, state key, and deployment configuration mounts are inside the recovery destination, and whose ingress declares two **new, nonexistent, non-external local-driver** volume names for `/data` and `/config`. Target names must differ from both archived source volume names. It may use only the policy's immutable target images. Keep the old source Compose and old Caddy volumes present and stopped.

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

Restore verifies both source and target projects have no running/restarting/paused service, then verifies the completion marker, payload and per-file checksums, five-root completeness, traversal/link safety, metadata inventory, predecessor/target image policy, PostgreSQL major, authority credentials, fresh bind destinations, structural target mounts, local Docker endpoint, and target Caddy volume names. `--create-fresh-caddy-volumes` explicitly authorizes automatic creation of exactly those two reviewed target volumes with Compose ownership labels and a one-time freshness label; a post-create empty check closes Docker's idempotent named-volume creation race. Existing volumes, source-volume reuse, external/NFS drivers, aliases and unfamiliar mounts are refused. All feasible non-mutating preflight finishes before either volume is created or archive extraction begins. The shared topology validator must read restored bind files, so it runs as a post-extraction condition; failure leaves evidence rather than cleaning it. Extraction never overwrites and **never starts either installation**. If second-volume creation or extraction fails, any new volume or partial destination is deliberately left for diagnosis; there is no destructive cleanup. Fix by choosing entirely new empty bind destinations and new volume names, not by cleaning or overwriting the evidence.

Rollback after an incompatible or ambiguous upgrade is this same cold restore into new directories/new Caddy volumes and an explicit later operator cutover. Never point restore at the old roots or old volumes, and never start old and restored copies together. Credential revocation/fencing outside the Compose host remains operator work.

Legacy artifact schemaVersion 1 contains only the three old roots and is fail-closed by default. The only supported exception is an intentional trust reset using both normal restore acknowledgements plus `--acknowledge-ingress-identity-reissue`. It still requires two fresh target Caddy volumes, reports `ingressIdentity: reissue-required-legacy-v1`, and does **not** claim preserved TLS identity. Redistribute the newly issued CA/trust before clients connect. Use v2 for trust-preserving recovery.

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

Preflight requires exact six-service topology, reviewed immutable predecessor/target maps, unchanged PG/SILO roots, unchanged Caddy data/config volume declarations, unchanged protected identity/config mounts, matching PostgreSQL major, and no migration. Apply repeats preflight, performs the successful five-root cold backup first, then starts the target with bounded `docker compose up --wait`. Startup failure is reported with secrets withheld; services and the completed backup remain for diagnosis. There is no automatic rollback, data deletion, image fallback, or command replay.

## Explicitly unsupported

- live/online or multi-host-consistent backup; HA fencing against a malicious root operator;
- automatic pruning, destructive in-place restore, or simultaneous source/restored startup;
- arbitrary schema/data migration, PostgreSQL major upgrade, or unreviewed image predecessor;
- automatic draining, settling, cancellation, or replay of external Executor/provider effects;
- vendor-neutral SILO export or service-managed retention/replication proof;
- automatic credential revocation, target Compose generation, or post-restore service start.
