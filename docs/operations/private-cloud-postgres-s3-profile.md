# Opt-in Private Cloud PostgreSQL/S3 (local-source and bundle evaluation)

This local-source profile and newly wired bundle Operator route are **single-Runtime, fresh-install evaluation paths**, not an upgrade, production-supported storage mode, or multi-Runtime/HA claim. It places control-plane data (including browser sessions and OIDC login state) in an operator-managed control PostgreSQL database and Runtime Unit/Session/Queue state in a separate operator-managed Runtime PostgreSQL database, with object-backed attachment/artifact bytes in S3-compatible storage. This does not include local-only trace/profile/export outputs. Neither `runtime-host` nor `runtime-ingress` mounts an authoritative application-data volume.

The profile disables, but does not delete, the base Compose `control-postgres` and `init-volumes` services. It replaces inherited dependencies and mounts rather than layering overlapping tmpfs/volumes. The legacy Compose profiles remain unchanged. Named `host-secrets`, `gateway-secrets`, `runtime-storage-secrets`, and `gateway-storage-secrets` volumes are restricted, rebuildable projections of host secret files; they are not database or object authority.

This does **not** establish that every Private Cloud component is free of local authority. Optional bundled identity has separate state, Docker/Compose metadata and secret source files remain host-local, and JSONL-dependent or other legacy capabilities still require audit. The published signed beta installer still defaults to `local-volume`; the bundle route described here exists in local source, not in an accepted/certified release asset.

## Preconditions

1. Provision an **existing, empty control PostgreSQL database** reachable from the Gateway and the one-shot migration job. Compose will not create the server or database. Create two distinct login roles and credentials:
   - a migration owner that owns the database/schema and can run all control-plane migrations;
   - an existing Gateway writer without database/schema creation, table ownership, or migration authority. The one-shot owner migration job grants this role the steady-state table DML and sequence usage/select privileges after every schema migration; it does not create roles or revoke excess pre-existing grants.

   Both URLs must select the same pre-created database. Use PostgreSQL TLS appropriate to the environment. The migration job first connects to that database and fails before reading/applying migrations if it is absent or unreachable. Migration checksum/version failures are fatal; the Gateway also refuses to start against a missing, stale, or modified schema. Do not grant the migration owner credential to the Gateway.

2. Provision a **separate Runtime PostgreSQL database** reachable by the Runtime, Gateway, and Runtime migration job. Create three distinct login roles in advance: migration owner (owns this database and `public` schema), Runtime DML writer, and Gateway read-only reader. Neither workload role may have DDL, table ownership, or elevated privileges. Do not reuse the control database or its roles.

3. Provision a **new, dedicated, completely empty** private S3-compatible bucket, endpoint, region, and a scoped access key with object read/write/list/delete, `ListBucketVersions`, `GetObject` for the installation marker, and conditional `PutObject` (`If-None-Match: *`) for that bucket. The endpoint must implement `ListObjectsV2` and `ListObjectVersions`; a bucket with old versions or delete markers is not empty. Both PostgreSQL databases must also have no existing application schemas/objects before the claim job runs. Ensure the Runtime has network access, correct CA trust, and a durable object backup/restore plan. No PostgreSQL server or object store is bundled.

4. Use Docker Compose **2.24 or newer** (`!override` is required). Configure an externally managed OIDC issuer/client reachable from the Gateway and operator, with a correctly registered callback; PG/S3 preflight checks OIDC discovery but does not require the repository's local shared Identity Compose project. Install as a **new Compose project** with new external databases and bucket. There is no supported migration or rollback from `local-volume` or experimental NFS. Do not change the profile of a running installation in place. Existing legacy volumes are deliberately left untouched; after a successful cutover and retention review, their disposition remains an operator action.

5. In `deploy/private-cloud/.secrets` (or `KALA_SECRETS_DIR`), create owner-readable, group/other-inaccessible files:
   - `control_postgres_migration_owner_url` and `control_postgres_writer_url`;
   - `runtime_postgres_owner_url`, `runtime_postgres_writer_url`, and `runtime_postgres_reader_url`;
   - `runtime_s3_access_key_id` and `runtime_s3_secret_access_key`;
   - `runtime_state_master_key`, containing exactly 32 raw random bytes.

   Each PostgreSQL file contains a full URL. Preserve and securely back up the Runtime state key; losing it makes encrypted Runtime state unreadable. Never place database URLs, passwords, S3 credentials, or this key in `deployment.env`, Compose environment values, command arguments, or Git. The legacy `control_postgres_password` file is not required by this profile.

6. Put only non-secret profile selection in the ignored `deployment.env`, alongside existing OIDC and immutable image settings:

   ```dotenv
   KALA_PROFILE=postgres-s3
   COMPOSE_PROJECT_NAME=kala-private-cloud-pg-s3-eval
   KALA_CONTROL_DML_ROLE=kala_control_writer
   KALA_RUNTIME_DML_ROLE=kala_runtime_writer
   KALA_RUNTIME_READER_ROLE=kala_runtime_reader
   KALA_S3_ENDPOINT=https://objects.example.test
   KALA_S3_REGION=example-1
   KALA_S3_BUCKET=kala-runtime-eval
   KALA_S3_FORCE_PATH_STYLE=false
   KALA_PG_S3_EXTERNAL_BACKUP_ACK=1
   ```

   The acknowledgement is an operator assertion only; it neither configures backups nor proves restore viability. For source-only Compose, generate and securely retain a canonical random UUID in a private file outside the container, then set `KALA_INSTALLATION_ID_FILE` to its absolute path in the invoking environment. Do not regenerate this ID on retry or point it at an existing project. The one-shot `fresh-storage-claim` job must finish before either schema migration: it checks both databases and the **entire** bucket, then writes matching external installation markers into both PostgreSQL databases and S3. A matching three-marker set may be retried with the same UUID; after a failed Operator `install`, the Operator tears down the fresh Compose project including its disposable secret volumes before retry, never the external databases or bucket. If cleanup was interrupted and project containers, volumes, or networks remain, preflight refuses reuse; investigate those resources rather than deleting external markers or choosing a new UUID. Any partial/mismatched marker set requires manual recovery, not automatic marker deletion. It is not a distributed transaction or a substitute for coordinated restore.

For the **local-source bundle Operator** instead, use `init-config --storage postgres-s3 --identity external --acknowledge-evaluation --acknowledge-external-backup` with a new configuration directory and project. This creates owner-only `storage-origin.json` and `installation-id`; retain both with the external backup/restore plan and never edit `KALA_STORAGE` to reuse a legacy config. Supply the external credentials, OIDC settings, provider catalog and 32-byte state key separately, then run `preflight` and `install`. `setup` cannot provision external credentials for this mode. Preflight validates the rendered claim/migration topology and rejects existing project containers, labeled volumes and networks but **does not itself inspect** the external databases/bucket; the claim job does so before migrations. No PG/S3 Operator upgrade, rollback, built-in backup/restore or uninstall is supported. Do not interpret a locally built bundle as a published signed release.

Before the first source-only apply, run:

```sh
node scripts/private-cloud-local/preflight.mjs
node scripts/private-cloud-local/validate-compose-policy.mjs
node scripts/private-cloud-local/deploy-profile.mjs apply
```

Source-only preflight checks secret-file shape/permissions, that both URLs select `runlab_control` and the writer role matches, distinct control migration and writer credentials, the disposable Runtime root, PostgreSQL login-state selection, absence of the Gateway control-data mount, disabled legacy database/init services, and the external database migration mode. It does not connect to PostgreSQL, inspect grants, configure TLS, or prove backup/restore; those remain operator preconditions. A failed claim may leave external markers behind. Preserve all three stores and their backups for forensic/manual recovery; do not delete a single marker and retry against mixed data.

## Failure and operational boundaries

- `fresh-storage-claim` uses the immutable installation ID and only the two migration-owner URLs plus bucket-scoped S3 credentials, with no local claim receipt volume. It rejects nonempty stores before migrations; the claim cannot atomically commit across PostgreSQL and S3. A lost/disagreeing marker fails closed.
- `control-plane-init` receives only `control_postgres_migration_owner_url`, requires the target database to exist, and runs migrations before the Gateway starts. `runtime-ingress` receives only the projected `control_postgres_writer_url` and stores organizations, browser sessions, and OIDC login state in PostgreSQL. It does not mount `control-data`.
- `runtime-schema-init` receives only the Runtime owner credential and executes versioned migrations/scoped grants before `runtime-host` starts. Runtime and Gateway receive their separate writer/reader credentials. Schema migration and startup checks fail closed.
- `init-app-secrets` and `init-storage-secrets` copy restricted host files into owner-restricted named volumes so non-root services can read them. These volumes can be recreated from the source secret files and contain no authoritative application records, but their host-local lifecycle and the authority of the source secret files are not solved by this profile.
- `/var/lib/kala` is bounded disposable tmpfs. Confirmed Session/Queue/Artifact authority must survive replacement through Runtime PostgreSQL/S3. For new queued messages with uploaded attachments, the PG/S3 Runtime writes an operation-ID-keyed reference-protection event and the Queue item in one owner-fenced PostgreSQL transaction. A Queue failure rolls back both: the object remains a pending upload for bounded expiry/release rather than becoming an unconsumed committed reference. Single-Runtime release, pending expiry and confirmation are serialized; a PG event guard blocks stale cross-replica pending releases after protection (and rejects admissions after a concurrent release). Local source now commits a PG Session deletion tombstone before HTTP/Dashboard queue, Executor and object cleanup, prevents fresh Queue admission from crossing the tombstone with a PG projection lock, and runs bounded periodic owner-fenced cleanup retries. Gateway route tickets return distinct deleting/missing terminal states and a retryable relocating state; Dashboard prepares owners only for relocation. The single-Runtime evaluation profile does not exercise multi-node takeover; already-dispatched external effects, atomic tree deletion, legacy pre-protected orphan reclamation, real fault/recovery acceptance and a general admission ledger are still missing. Session fork now derives its child from the persisted creation state and durable event prefix and commits the child under PG ownership fencing before reporting success. File-based enhancement actions, including trace/profile/export, reject PG-backed Sessions even if a caller supplies a `rootDir`; these outputs are **not** available as durable PG/S3 artifacts. Other local-state paths still require capability audit and must not be assumed durable merely because they can write scratch.
- `KALA_RUNTIME_NODE_ORIGIN` and the Gateway allowlist/bootstrap origin identify the sole mTLS `runtime-host`. This is not placement failover or parallel execution; migration, drain, and cross-node takeover runbooks remain future work.
- The built-in local-volume backup and Unit export/restore explicitly refuse this profile. Operators must coordinate recoverable snapshots of both PostgreSQL databases, S3 objects/versions, secret source files, and the Runtime state key, then rehearse restore on a new installation. `deploy-profile.mjs apply` refuses an existing PG/S3 project because its automated backup cannot protect these authorities.
- Do not infer Enterprise Pilot acceptance, customer-network compatibility, supported-version upgrade/rollback, all-local-authority removal, or multi-Runtime continuity from this evaluation profile.
