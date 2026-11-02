# Dedicated Owner and credential lifecycle

This runbook applies only to a **Dedicated, canonical single-Organization** installation. The Owner commands operate directly on control PostgreSQL with an administrative database credential. They never bootstrap an Owner, provision an Organization, change the Owner principal/membership, or treat a service token as human authority.

## Security boundary

Run from the published Gateway package with `KALA_DEPLOYMENT_CONFIG`, `KALA_INGRESS_MIGRATIONS_DIR`, and the normal PostgreSQL control-plane secret-file configuration set for the installation. The database role must be able to update `dedicated_owner_credentials` and `browser_sessions`; the steady-state Gateway writer intentionally cannot replace the password columns. Do not grant that extra authority to the running Gateway.

Passwords are accepted only from regular, non-symlink files with no group/other permissions. Direct password environment variables and command-line password values are rejected. Use a root-private `0700` temporary directory, create each file as root with mode `0600`, avoid shell history, and securely remove the temporary files after recording command success according to local policy. The command emits only IDs, event name, and revoked-session count; it does not emit a password or verifier.

Both operations:

- require the existing singleton credential, canonical `urn:kala:dedicated-owner` / `owner` human principal, active Owner membership, active Organization, current contract entitlement, and exactly one Organization;
- retain the existing principal and Organization IDs;
- replace the verifier with the production scrypt policy (never weakening it) and reject reuse of the current password;
- serialize with bootstrap and other credential updates, compare the locked old verifier before replacement, and fail closed on stale or malformed state;
- revoke every non-revoked PostgreSQL-backed browser session for that Owner with reason `administrator` in the **same transaction** as the password replacement. A failed operation changes neither credentials nor sessions.

The new password must be at least 14 characters, between 12 and 1024 UTF-8 bytes, and match a separately supplied confirmation file.

## Normal password change (current password known)

This is the supported routine rotation path. It verifies the current Owner password; it is not an authenticated web API and does not require Dashboard changes.

```sh
sudo install -d -m 0700 -o root -g root /run/kala-owner-change
sudo sh -c 'umask 077; cat > /run/kala-owner-change/current'
sudo sh -c 'umask 077; cat > /run/kala-owner-change/new'
sudo sh -c 'umask 077; cat > /run/kala-owner-change/new-confirm'

sudo env \
  KALA_DEPLOYMENT_CONFIG=/secure/kala/deployment.json \
  KALA_INGRESS_MIGRATIONS_DIR=/opt/kala/gateway/migrations \
  KALA_INGRESS_DATABASE_URL_FILE=/secure/kala/control-admin-database-url \
  KALA_DEDICATED_OWNER_CURRENT_PASSWORD_FILE=/run/kala-owner-change/current \
  KALA_DEDICATED_OWNER_NEW_PASSWORD_FILE=/run/kala-owner-change/new \
  KALA_DEDICATED_OWNER_NEW_PASSWORD_CONFIRM_FILE=/run/kala-owner-change/new-confirm \
  /opt/kala/gateway/node_modules/.bin/kala-dedicated-owner-rotate

sudo rm -f /run/kala-owner-change/current /run/kala-owner-change/new /run/kala-owner-change/new-confirm
sudo rmdir /run/kala-owner-change
```

Success is one JSON record with event `dedicated_owner_password_changed`. All previously logged-in browsers must sign in again. Confirm a new login through the normal ingress; never test by placing a password on a command line.

## Lost-password local recovery

Recovery deliberately bypasses knowledge of the old password. Therefore all of these are mandatory and independently checked on POSIX hosts:

1. execute the command as local UID 0;
2. both new-password files are owned by UID 0 and inaccessible to group/other users;
3. pass the exact acknowledgment `--acknowledge-local-root-owner-recovery`.

A Gateway/service-account token is neither requested nor accepted as recovery authority. Possession of a database/service secret alone is not the documented authorization procedure.

```sh
sudo install -d -m 0700 -o root -g root /run/kala-owner-recovery
sudo sh -c 'umask 077; cat > /run/kala-owner-recovery/new'
sudo sh -c 'umask 077; cat > /run/kala-owner-recovery/new-confirm'

sudo env \
  KALA_DEPLOYMENT_CONFIG=/secure/kala/deployment.json \
  KALA_INGRESS_MIGRATIONS_DIR=/opt/kala/gateway/migrations \
  KALA_INGRESS_DATABASE_URL_FILE=/secure/kala/control-admin-database-url \
  KALA_DEDICATED_OWNER_NEW_PASSWORD_FILE=/run/kala-owner-recovery/new \
  KALA_DEDICATED_OWNER_NEW_PASSWORD_CONFIRM_FILE=/run/kala-owner-recovery/new-confirm \
  /opt/kala/gateway/node_modules/.bin/kala-dedicated-owner-reset \
  --acknowledge-local-root-owner-recovery

sudo rm -f /run/kala-owner-recovery/new /run/kala-owner-recovery/new-confirm
sudo rmdir /run/kala-owner-recovery
```

Success is one JSON record with event `dedicated_owner_password_reset`. Treat use of this path as a security event and preserve external operator audit evidence without copying secret contents.

## Non-Owner credentials and Runtime state master key

There is **no claimed generic online rotation** for PostgreSQL role passwords, SILO/S3 access keys, inter-service authentication secrets, or private TLS material in this repository. The lifecycle operator can cold-backup, verify a published six-service topology, and start a reviewed staged configuration; it does not coordinate provider-side credential replacement, dual-key overlap, rollback, or revocation. Do not improvise an in-place `ALTER ROLE`, SILO key deletion, or one-container-only restart and call it supported rotation.

For a separately reviewed, service-specific procedure, stage root-owned published inputs and first run the existing topology validators without exposing resolved secret values:

```sh
sudo docker compose --env-file /secure/staged.env -f /secure/staged/docker-compose.yaml config --quiet
sudo python3 ./verify-published-compose.py /secure/staged/docker-compose.yaml /secure/staged.env
```

Only if that credential's producer and every consumer have a documented overlap/revocation sequence may operators use the existing cold backup and controlled startup procedure in `lifecycle-operator.md`. Validation proves topology/config parsing, **not** that a new database/SILO/service credential works. Keep the old credential available for the reviewed rollback window, test through the normal ingress after bounded startup, then revoke it at its authority. If no provider-specific sequence exists, rotation remains unsupported and must stop at planning.

The Runtime state master key is an encryption root, not a replaceable service password. Arbitrarily changing its file makes persisted encrypted session/provider material unreadable. Existing backup and restore intentionally require the same key fingerprint. This repository has no decrypt-and-re-encrypt migration, dual-key reader, or online key rotation command; therefore **never replace the state master key on an existing installation**. Loss of that key requires restoration of the matching protected key and data from a verified backup; a fresh key is only valid for a fresh installation with no encrypted state to retain.
