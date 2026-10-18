# Operations

Operational instructions are specific to deployment mode and release. Before applying a procedure, check the [deployment mode contract](../architecture/deployment-mode-contract.md), the [release support policy](release-support-policy.md), and the version of the system you are operating. Proposals and historical handoffs are not runbooks.

## Install and maintain

- **Portable:** start with the [published release overview](../../README.md#releases). The portable release is managed by its operator; do not use Dedicated cutover instructions for it.
- **Dedicated:** [operator CLI](dedicated-operator-cli.md), [Runtime cutover and rollback](dedicated-platform-runtime-unit-cutover.md).
- **Private Cloud:** [first installation](private-cloud-first-install.md), [local deployment runbook](private-cloud-local-runbook.md), and [release lifecycle](private-cloud-release.md).
- **Linux Desktop:** [release and packaging](linux-desktop-release.md).

## Cross-deployment responsibilities

- [Backup and restoration](control-plane-backup-restore.md), [scheduled-task writer recovery](scheduled-task-writer-lock.md), and [tenant lifecycle](commercial-saas-tenant-lifecycle.md).
- [Release evidence](release-evidence-contract.md), [public readiness](public-release-readiness.md), and [support and rollback policy](release-support-policy.md).
- [Supply-chain security standard](../standards/security/supply-chain-security.md) describes constraints to follow; it is not an installation command.

Historical [Dedicated migration handoffs](../archive/programs/dedicated-platform-systemd-external-agent-handoff.md) are retained for context only; do not use them in place of the current operator guide.
