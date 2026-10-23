# Dedicated operator CLI

**Status:** normative

**Scope:** source-free installation and lifecycle operations for the Linux
systemd distribution of Kala Dedicated

## 1. Command surface

The release bundle contains `kala-dedicated.mjs`. Installation publishes the
same program as `/usr/local/bin/kala-dedicated`. Operators use this entry point for installation and Runtime/control-plane lifecycle:

```text
kala-dedicated install --release-dir <verified-release>
kala-dedicated status
kala-dedicated upgrade --release-dir <verified-release>
kala-dedicated rollback <deployment-id>
kala-dedicated backup --output <persistent-empty-directory>
kala-dedicated restore --backup <backup-directory> --confirm RESTORE:<backup-id>
kala-dedicated uninstall --confirm UNINSTALL:<installation-id>
```

Legacy migrations select a non-default predecessor service through the private
`/etc/kala/migration.env` file described by the migration runbook. The
public command never rewrites an existing private environment file.

The command runs locally on the target through an independent operator shell. It
does not require a Git checkout, package manager, compiler, or application build.
Release verification happens before installation or upgrade.

`upgrade` and `rollback` are thin clients of the versioned Deploy Supervisor
request/receipt protocol. They do not stop a service directly, call the Portable
restart endpoint, or maintain a second deployment state machine.

The independent Dashboard has a separate release lane. From a source checkout use
`pnpm run deploy:dashboard -- stage`; from a release bundle use
`node deploy-dashboard.mjs stage`. Both support `status`, `wait`, `inspect`, and
Dashboard rollback. `kala-dedicated upgrade` does not advance Dashboard generation,
and a Dashboard-only activation does not restart Ingress, Runtime, Sessions, or
Executors.

## 2. Install state

`install` runs the staged systemd installer first. The installer must leave every
new service disabled and inactive and persist `installed_disabled` before the CLI
may activate anything. A clean installation then runs the same restart-safe
Migration Finalizer without a legacy predecessor. A legacy migration supplies an
explicit legacy state root and service and follows the external migration runbook.

`--stage-only` ends after disabled installation. It is intended for reviewed
migrations and clean-system acceptance, not as a claim that the product is live.

## 3. Upgrade and rollback

An upgrade transfers the exact release manifest into an operation-scoped immutable
submission, atomically submits one request, prints the accepted operation and
deployment IDs, and waits for the authoritative terminal receipt unless
`--no-wait` is selected. RC and production automation use the same operation.

Rollback names the completed deployment whose verified predecessor is required.
The Supervisor owns continuation, admission reconciliation, candidate activation,
route fencing, health verification, and rollback recovery.

### Windows Workspace installers

A Linux-only local Runtime build does not include native Windows Executor assets.
Updating Runtime or Dashboard alone therefore does not enable Windows in Add
Workspace. `/api/executor-install-capabilities` reports Windows available only
when the Host can verify `kala-executor-win32-x64.exe`,
`kala-executor-service-host-win32-x64.exe`, `node-pty-win32-x64.tar.gz`, and
`install-executor.ps1` against its served `SHA256SUMS`.

For local builds, provision a persistent, read-only installer directory from a
verified official release and set `KALA_RELEASE_ASSETS_DIR` for both Runtime
slots through the private environment configuration or a systemd template
drop-in. Include the matching Linux/macOS installers and Executor assets as well:
an external checksum index must not describe different versions of fallback
embedded assets. Keep this directory outside immutable Runtime release roots,
and activate configuration changes through a Supervisor-owned deployment.
Verify Windows readiness and the actual served payload hashes after cutover;
never remove the Dashboard availability guard to compensate for missing assets.
The Windows installer supports Windows PowerShell 5.1: architecture detection uses
the native Windows environment and OS bitness, not the optional .NET
`RuntimeInformation.OSArchitecture` property. An AMD64 OS is supported even from
a 32-bit PowerShell process; ARM64 and 32-bit Windows remain unsupported.
Windows **service** installation requires an elevated PowerShell window, even
when the signed-in account is named `admin` or belongs to Administrators. Open
PowerShell with **Run as administrator**, then paste the generated command.
The bootstrap checks the command's service-mode hint before downloads or setup
code consumption and rechecks the authoritative mode returned by the Host before
starting the Executor. Temporary mode does not require elevation. A setup code
already claimed by an older installer must be regenerated after a failed attempt.
Script and Linux-side checks do not establish Windows service acceptance: that
requires a real Windows run covering installation, SCM startup, Host connection,
ConPTY operation, and uninstallation.

## 4. Backup state machine

Backups are offline-consistent transactions, not best-effort live tar files:

```text
planned -> waiting_for_boundary -> reserved -> services_stopped
        -> archived -> verified -> services_started -> completed
```

The operator waits for a safe Runtime boundary and reserves admission before it
stops the routed Runtime, Stable Ingress, and Supervisor. The archive covers the
complete data root, installed control files, private configuration root, and exact
Dedicated unit files. Every archive has a byte count and SHA-256 in a versioned
manifest. Verification extracts every archive into a disposable directory and
compares the restored tree before the original services resume.

The output directory must be absolute, persistent, empty, outside every backed-up
root, and created with private permissions. A failed transaction retains its
receipt and makes a best effort to restore the previously active services; it never
reports a completed backup merely because archive files exist.

## 5. Restore state machine

Restore is deliberately target-bound and fail-closed:

```text
planned -> verified -> waiting_for_boundary -> services_stopped -> extracted
        -> targets_replaced -> units_restored -> services_started -> completed
```

The confirmation is the exact `RESTORE:<backup-id>` printed by backup inspection.
Before replacing anything, the CLI verifies the manifest and all hashes, extracts
into sibling staging directories, and verifies the extracted trees. Current roots
are moved to operation-scoped sibling recovery paths on the same filesystem rather
than deleted; unit files use a separate private recovery root. Atomic directory
renames commit data, install, and configuration roots.
Unit files are replaced one at a time using durable atomic writes, followed by
`systemctl daemon-reload`. If a later step fails, the recovery transaction restores
the predecessor targets and fails closed.

Restore never merges Session JSONL or starts two Runtime writers against one state
root. The retained predecessor recovery directory is removed only by a later,
explicit operator cleanup.

## 6. Uninstall contract

`status` publishes a stable installation ID. Uninstall requires the exact
`UNINSTALL:<installation-id>` confirmation, then stops and disables only the six
Kala Dedicated units, removes only their exact unit files, the installed
operator link, and the bounded `/opt/kala` control root. It preserves
`/var/lib/kala`, `/etc/kala`, immutable releases, receipts,
backups, service identity, and user data. This command has no data-purge mode.

## 7. Receipts and recovery

Lifecycle receipts use a versioned schema, monotonic revision, explicit transition
table, operation ID, timestamps, bounded redacted error, and target identities.
They are durably atomically replaced under `/var/lib/kala-operator`; this
root is outside the data root so restore cannot replace its own recovery authority.
An incomplete receipt blocks a new lifecycle operation until the operator has
inspected it and completed bounded recovery; it is never silently discarded or
overwritten. Supervisor-owned upgrade and rollback operations remain automatically
restart-resumable under their request/receipt protocol.

No receipt contains provider credentials, environment-file contents, Session
messages, or secret values. Local target paths are private operator evidence and
must not be committed to the repository.
