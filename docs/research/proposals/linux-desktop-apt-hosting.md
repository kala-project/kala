# Linux desktop APT hosting and key custody

Status: proposed, awaiting owner approval. No production domain, bucket, key,
DNS record or signing identity is created by this design.

## Installation contract

The website provides one complete, readable Bash snippet. Pasting it checks the
architecture, installs distribution-provided prerequisites, downloads the public
key over HTTPS, automatically compares its primary fingerprint with a literal
approved fingerprint, writes a per-repository Deb822 source with `Signed-By`,
runs `apt-get update`, and installs `agent-runlab-desktop`. Every failure stops
installation. No `curl | bash`, `apt-key`, global trust or signature bypass.

The command is generated from the actual approved HTTPS repository URL and full
primary fingerprint; no user-editable placeholders appear in a live installation
snippet. Publish the fingerprint independently of the repository (for example
in an owner-approved signed release announcement). Automatic comparison protects
against a substituted downloaded key, not compromise of both the website and
the independent trust announcement.

An unsigned candidate must not show a functional-looking APT install command.
Keep direct candidate downloads explicitly separate from the production channel.

## Proposed infrastructure

Use an owner-controlled HTTPS subdomain and a dedicated static object store or
static web server behind it. The exact domain/provider/account must be approved;
do not assume ownership of a repository-derived domain.

* Serve the signed repository at a stable URL, without authentication or redirects
  to HTTP. Hosting contains public keys and signed packages only.
* Keep versioned package objects immutable. Preserve old `pool/` objects across
  releases, including when changing the currently supported release.
* Promote verified metadata atomically; use short/no caching for `InRelease`
  and release pointers. Implement content-addressed APT by-hash indexes before
  deploying through a CDN that cannot provide consistent metadata promotion.
* Refresh 14-day-expiring metadata at least weekly, even without a new package.
  Alert on a failed refresh, TLS expiry and repository unavailability.
* Retain signed previous metadata for recovery. Rollback must not silently
  downgrade installed clients; ship a monotonically higher corrective version.

## Signing separation

Create a dedicated OpenPGP release identity only after approval. Keep its primary
key offline/hardware-backed with encrypted recovery material under the owner's
control. Use a restricted signing subkey on a separate controlled signing host,
not on the public web server or in this repository.

The builder records artifact-bound dependency locks and provenance. The signing
host independently verifies those records and audit results before signing.
Publishing credentials can upload only to the dedicated repository prefix;
they cannot obtain the signing private key. Never persist private/test keys in
source, download directories, build logs or release artifacts.

Define owners for revocation, rotation, backup and scheduled metadata signing.
Rotate with an overlap period: distribute the next key through the currently
trusted channel before switching signatures. Update the website's literal
fingerprint only after independent approval. Emergency revocation and recovery
must not use `trusted=yes` or disable TLS/signature checks.

## Publication acceptance

Before copying the generated `apt-install.json` to the Dashboard, resolve the
native and relevant JavaScript dependency blockers, approve key/hosting custody,
serve the signed repository over its real HTTPS URL, and run the exact generated
snippet on a clean supported Ubuntu amd64 machine. Exercise rerun, update to a
higher package version, wrong fingerprint, invalid signature and expired
metadata. No source or trust changes may occur after a failed fingerprint.

The publisher emits installation metadata only after successful signed staging;
this is not proof that its proposed public URL is live. Deployment of that
metadata remains a separate, approved release action.

## Decisions required before creating infrastructure

1. Owner-controlled domain and static hosting account/provider.
2. Signing-key custodian, backup/recovery owner and approved signing host.
3. Independent fingerprint publication channel.
4. Scheduled metadata signing/refresh operator and monitoring destination.
