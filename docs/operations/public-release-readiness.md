# Public repository and release readiness

**Status:** normative; implementation in progress

**Target:** `v0.3.0` (candidate; do not mark accepted before exact-tag evidence)

**Scope:** public source repository, supported Portable artifacts, preview
Dedicated bundles and Private Cloud images/bundles, and release evidence

## 1. Release contract

One product release uses one SemVer version and one tag, such as
`v0.3.0`. The root package, workspace packages, manifests,
Dashboard metadata, container labels, and release notes must agree.
Protocol and persisted-schema versions are independent compatibility contracts and
must not be changed merely to match the product version. Component-specific tags
are not part of the target release model.

The release is built from a clean, signed or protected Git revision. Generated
assets record the exact revision and content digest. This stable pre-1.0 release may be
published only after privacy, license, build, test, signed-asset verification,
GHCR image vulnerability scanning, and the four-target hosted Portable clean
install/reinstall matrix pass (Linux x64, macOS x64/arm64, Windows x64 with
ConPTY). Upgrade, rollback, backup/restore, and
Dedicated/Private Cloud lifecycle checks are **not certified** by this release.

## 2. User-facing distributions

| Variant | Distribution | Required user workflow | Dashboard lifecycle |
|---|---|---|---|
| Portable | Node.js 22+ CJS Host and Executor with platform runtime dependencies | download, verify, run | embedded and upgraded with Runtime |
| Dedicated | signed Platform release bundle and systemd operator CLI | install, status, upgrade, rollback, backup, restore, uninstall | independent immutable release |
| Private Cloud | signed multi-architecture images plus a versioned Compose bundle | configure secrets, preflight, install/upgrade/rollback with no source checkout | independent image |

Every variant is self-hosted. Dedicated is Platform with `single-tenant`; Private
Cloud is the same Platform architecture with `multi-tenant`.

## 3. Required gates

### Repository and governance

- [x] MIT project license.
- [x] Security policy, code of conduct, contribution guide, issue/PR templates,
  CODEOWNERS, and changelog.
- [x] Snapshot and complete-history privacy scanning.
- [x] Production dependency license allowlist with exact review for non-SPDX metadata.
- [x] Release documentation matches the shipped installation assets.
- [x] Repository metadata, package links, and release support policy are finalized.

### Version and supply chain

- [x] One product version is enforced across packages and artifacts.
- [x] Linux and macOS x64/arm64 Portable build jobs exist on matching runners.
- [ ] Windows x64 Portable Host, CJS Executor, ConPTY, and installer lifecycle
  must pass the exact-tag hosted acceptance before promotion. Windows assets
  are required by the current release and promotion workflows, not excluded.
- [x] GitHub release assets have a keyless checksum signature and GitHub build
  provenance; container digests have keyless signatures, OCI provenance, and SBOMs.
- [x] CycloneDX SBOMs and third-party notices ship with GitHub release assets.
- [x] Vulnerability scanning uses an explicit severity/exception policy.

### Operator experience

- [x] Dedicated provides preview install, status, upgrade, rollback, backup,
  restore, and uninstall commands without requiring a source checkout; production
  lifecycle acceptance remains incomplete.
- [x] Private Cloud has a digest-pinned multi-architecture image workflow and a
  versioned Compose bundle that does not build application source on the operator
  machine. Publishing remains gated on clean-environment acceptance.
- [x] Destructive commands identify bounded targets, require explicit intent, and
  preserve recoverable data by default.

The normative Dedicated command and recovery contract is
[`dedicated-operator-cli.md`](dedicated-operator-cli.md).
The normative Private Cloud bundle and lifecycle contract is
[`private-cloud-release.md`](private-cloud-release.md).

### Acceptance

- [ ] Portable passes clean Linux and macOS x64/arm64 install/run/reinstall checks.
- [ ] Dedicated passes clean systemd install, graceful cutover, rollback, reboot,
  backup/restore, Browser, Executor, and self-deployment checks.
- [ ] Private Cloud passes clean Compose install, tenant isolation, image upgrade,
  Dashboard-only update, rollback, backup/restore, and Executor checks.
- [x] Releases remain drafts until the Portable matrix and both
  artifact and image workflows succeed at the exact tag and revision. The
  promotion workflow fails closed on those checks before clearing the draft.

## 4. Evidence and privacy

Release evidence records revision, version, asset/image digest, test result, target
platform, operation phase, and rollback result. It must not contain real domains,
IPs, credentials, private filesystem paths, Session content, receipts from a private
installation, or screenshots with private data. Generated local evidence stays
outside Git unless it is deterministic, redacted, reviewed, and explicitly approved.

The normative machine-readable contract and promotion sequence are documented in
[`release-evidence-contract.md`](release-evidence-contract.md). Workflow existence
is not acceptance evidence. The first three acceptance boxes remain open until the matching runners have
produced successful evidence for the exact draft revision. Only the Portable
box gates promotion of this release; the other two are explicitly
unsupported preview variants until independent acceptance exists.

## 5. Stop conditions

Do not publish when a required Portable platform has no verified artifact,
a digest/signature cannot be reproduced, an unknown license remains, history
privacy scanning fails, or clean install needs repository source unexpectedly.
Never advertise an unverified Dedicated or Private Cloud preview as a supported
deployment. Partial packaging or Dashboard deployment alone is not readiness.
