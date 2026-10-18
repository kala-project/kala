# Supply Chain Security

Apply these rules whenever adding or updating packages, actions, build tools, release assets, or downloaded binaries.

## Dependency selection

- Pin direct dependencies and build tools to exact versions. Do not use `latest`, floating tags, broad ranges, or unbounded URLs.
- Commit the package-manager lockfile and require frozen/immutable lockfile installs in CI and release builds.
- Prefer packages with an established maintenance history, clear ownership, signed or verifiable releases, and active vulnerability reporting.
- Do not adopt a package version published within the last 24 hours. The cooling period allows time for malicious releases, compromised maintainers, regressions, and provenance problems to be discovered.
- The only exception to the 24-hour cooling period is a documented, concrete vulnerability alert that requires the newer version. Record the advisory identifier, affected versions, chosen fixed version, and why no older safe release is sufficient.
- Minimize new dependencies. Prefer existing audited libraries, platform APIs, or small local implementations when they reduce third-party execution risk without sacrificing correctness.

## Verification

- Review the package source, ownership changes, release notes, dependency changes, install scripts, and requested permissions before adoption.
- Verify registry identity and provenance. Use integrity hashes, signed attestations, checksums, or vendor signatures where available.
- Pin GitHub Actions and other remote build inputs to immutable commit SHAs or content digests, with the human-readable version recorded in a comment.
- Download release tools and binaries only from approved HTTPS origins. Verify a pinned checksum before execution.
- Treat postinstall, prepare, lifecycle, and downloaded executable code as privileged. Disable scripts when they are unnecessary; otherwise review them explicitly.
- Review transitive dependency and lockfile diffs. Unexpected package additions, source changes, integrity changes, or registry changes block the update.

## Pinned release binary record

The Windows x64 Executor service wrapper is the upstream WinSW `v2.12.0` asset `WinSW-x64.exe`, redistributed as `kala-executor-service-host-win32-x64.exe` under WinSW's MIT license.

- Source: <https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe>
- Size: `18,243,033` bytes
- SHA-256: `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`
- Machine: PE x64 (`0x8664`)

Release builds download only this versioned HTTPS URL and fail closed unless all recorded properties match. Installers obtain the renamed asset through the Host-mediated or signed release manifest path; they never download WinSW directly from GitHub.

## Change and release controls

- Keep dependency updates separate from unrelated behavior changes so their provenance and impact can be reviewed independently.
- Run license, vulnerability, privacy, build-policy, and release-asset checks before merging or publishing.
- Build releases from a clean, reproducible checkout with the frozen lockfile. Do not package local caches, credentials, developer paths, or untracked binaries.
- Generate and verify release manifests and checksums. Preserve enough metadata to identify the source revision, dependency lockfile, and build process.
- Never weaken verification merely to make an update pass. If provenance, integrity, ownership, or vulnerability status is unclear, stop and require explicit review.

## Exception record

Every exception must be narrow, temporary, and reviewable. Record:

1. The dependency and exact version.
2. The vulnerability advisory or operational requirement.
3. Why the normal 24-hour cooling period or pinning rule cannot be followed.
4. The verification performed.
5. The owner and planned follow-up or expiry date.
