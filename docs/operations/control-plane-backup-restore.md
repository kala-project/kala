# Control PostgreSQL backup/restore component — not a whole-product restore

**Scope:** this procedure covers only control PostgreSQL in a named existing installation. A successful dump/PITR restore here does **not** recover a target Dedicated or Private Cloud Session, attachment or Agent. The [three-mode target](../architecture/deployment-mode-contract.md) and [Private Cloud recovery invariant](../architecture/private-cloud-enterprise-architecture-contract.md) take precedence.

## Objectives

Pilot objective: **RPO 15 minutes, RTO 4 hours**. Contracted production targets require PostgreSQL WAL archiving/managed PITR and quarterly measured restore drills; nightly logical dumps alone do not satisfy the RPO.

## Backup layers

1. Continuous WAL archive plus daily base backup (or managed PostgreSQL PITR equivalent).
2. Daily custom-format `pg_dump` for portable recovery and pre-migration backups.
3. Separate provider backups for external identity, Runtime PostgreSQL and S3-compatible object bytes; **independently timed copies do not form a valid whole-product recovery set**. The current command backs up control PostgreSQL only.
4. Backup manifests include byte length and SHA-256; backup storage is encrypted, access logged and retention controlled.

## Portable-format control PostgreSQL dump (not Portable mode)

```bash
export KALA_INGRESS_DATABASE_URL='postgresql://...'
export KALA_BACKUP_DIR=/secure/backup/control-plane
node scripts/private-cloud-local/backup-control-plane-postgres.mjs
```

The command requires PostgreSQL client tools matching or newer than the server major version. Never place credentials in command history; production resolves them from a protected file/service environment.

## Disposable restore drill

Create an empty disposable database, point `KALA_INGRESS_DATABASE_URL` at it, then run:

```bash
node scripts/private-cloud-local/verify-control-plane-restore.mjs /secure/backup/control-plane/control-plane-TIMESTAMP.dump
```

The verifier checks the manifest, restores with `--exit-on-error`, and reports schema, Organization, membership, browser-session, Audit and Usage counts. Follow with control-plane checks for login, authorization and Unit placement. Do **not** claim a restored Session from this control-only drill; a Session requires a separately coordinated Runtime PostgreSQL/S3 restore.

A restore drill fails if any of these are missing:

- exact backup/target timestamps and measured duration;
- PostgreSQL/server/client versions;
- manifest checksum;
- row-count and application-level verification;
- documented operator and corrective action.

## Complete PG/S3 recovery gate (not implemented by this script)

A whole-product recovery set for **new Dedicated** includes its same-host control and Runtime PostgreSQL databases, SILO object versions/inventory, installation identity, required encryption/state keys and secret references. For **Private Cloud production**, the same logical set uses operator-managed PostgreSQL PITR and external versioned S3 across distinct failure domains. Local PG/S3 is a valid recovery-test substrate, not HA proof. Stop/fence all writers during recovery-set marking and provider snapshots; preserve exact snapshot/version inventory and key material, then restore onto new application nodes. Isolate old owners and revoke old credentials before admitting traffic. Compare installation and recovery markers, but do not mistake matching markers for an atomic cross-store snapshot. Verify browser-session revocation, Session/Queue/pending call and Executor receipts, object references and bytes, real SDK continuation, and explicitly unknown external effects. No complete, validated recovery/rollback operator exists yet; fail closed rather than using this control-only PITR as one.

## Control PostgreSQL PITR component

1. Declare incident and stop/deny control-plane mutations while preserving evidence.
2. Provision a new PostgreSQL target; never restore over the only copy.
3. Restore latest base backup and replay WAL to the timestamp immediately before the destructive event.
4. Verify schema ledger checksums, Organization/Owner invariants, placements, Audit/Usage monotonicity and Outbox state.
5. Start one Gateway against the recovered target, run authentication/authorization/runtime smoke, then shift traffic.
6. Preserve the failed database read-only until incident closure.

## Retention and deletion

Recommended starting policy: daily logical dumps 14 days, weekly 8 weeks, monthly 12 months; WAL/base-backup retention sufficient for the contractual PITR window. Organization deletion reaches backups only by backup expiry; deletion evidence records that expiry date. Legal/contract policy overrides this default.
