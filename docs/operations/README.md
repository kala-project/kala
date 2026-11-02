# Operations

Operational instructions are specific to deployment mode and release. Before applying a procedure, check the [deployment mode contract](../architecture/deployment-mode-contract.md), the [release support policy](release-support-policy.md), and the version of the system you are operating. Proposals and historical handoffs are not runbooks.

## Install and maintain

- **Portable:** start with the [published release overview](../../README.md#releases). The portable release is managed by its operator; do not use Dedicated cutover instructions for it.
- **Dedicated, new target:** Aspire-defined externally deployed Compose with same-host PostgreSQL/SILO and built-in Owner; [architecture target](../architecture/deployment-mode-contract.md) and [incomplete AppHost subset](../../deploy/aspire/README.md). **No accepted installation procedure exists yet**; do not use the old systemd cutover for a new installation.
- **Dedicated, existing systemd installations only:** [operator CLI](dedicated-operator-cli.md) and [systemd cutover/rollback](dedicated-platform-runtime-unit-cutover.md). These do not authorize in-place conversion to Aspire.
- **Private Cloud, current released installations only:** [first installation](private-cloud-first-install.md), [legacy local-volume/NFS runbook](private-cloud-local-runbook.md) and [release lifecycle](private-cloud-release.md). The [fresh PG/S3 source evaluation](private-cloud-postgres-s3-profile.md) is not a production HA or supported upgrade procedure.
- **Linux Desktop:** [release and packaging](linux-desktop-release.md).

## Cross-deployment responsibilities

- [Control PostgreSQL backup component (not whole-product restore)](control-plane-backup-restore.md), [scheduled-task writer recovery](scheduled-task-writer-lock.md), and [tenant lifecycle](commercial-saas-tenant-lifecycle.md).
- [Release evidence](release-evidence-contract.md), [public readiness](public-release-readiness.md), and [support and rollback policy](release-support-policy.md).
- [Supply-chain security standard](../standards/security/supply-chain-security.md) describes constraints to follow; it is not an installation command.

Historical [Dedicated migration handoffs](../archive/programs/dedicated-platform-systemd-external-agent-handoff.md) are retained for context only; do not use them in place of the current operator guide.
