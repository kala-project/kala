# Releasing

Kala uses one product version and one Git tag across the monorepo.
A matching version tag identifies the source revision, Portable assets,
Dedicated bundle, Dashboard manifest, and Private Cloud images produced by
that release. Protocol and persisted-schema versions
remain independent compatibility contracts.

## Version gate

All workspace `package.json` files use the root product version. Public packages
must declare MIT and cannot depend on private workspace packages. Verify before
cutting a tag:

```bash
pnpm run verify:version -- --tag v0.2.0
```

The release asset verifier repeats the check against `release/manifest.json`.
There are no component-specific product tags. Independent Dashboard updates use
the Dashboard Supervisor generation/release protocol and retain the product
version of the source release from which they were built.

## npm packages

This release does not publish workspace packages to npm. Product version tags
trigger GitHub Release assets and Private Cloud images only. The local package
validation tools remain available for a separately approved future npm release.

## GitHub Release assets

The `GitHub Release Assets` workflow also accepts only the unified `v*` tag. Its
current release matrix builds matching-runner Node SEA assets for Linux x64
and macOS x64/arm64. Linux arm64 and Windows are paused; SEA binaries are never
cross-compiled or relabeled. The CJS job builds portable fallbacks, the Dashboard
archive, Dedicated support archive, release metadata archive, manifest, and
checksums. The final job merges exact
artifacts and regenerates all metadata before publication.

Important assets include:

| Asset | Purpose |
|---|---|
| `kala-dashboard-with-runtime.cjs` | Portable Runtime with embedded Dashboard |
| `kala-host-<os>-<arch>` | Native Portable Runtime |
| `kala-executor.cjs` | Node.js Executor fallback |
| `kala-executor-<os>-<arch>` | Native Executor |
| `kala-runtime.cjs` | Platform Runtime without embedded Dashboard |
| `kala-dashboard.tar.gz` | Independent Platform Dashboard static files with embedded `dashboard-release.json` |
| `kala-release-metadata.tar.gz` | CycloneDX SBOM, third-party notices, and release notes |
| `run.sh` | Checksum-verifying Portable bootstrap |
| `manifest.json` and `SHA256SUMS` | External release identity and integrity |

The `.cjs` assets require Node.js 22+. `run.sh` prefers them when Node 22 is
available and otherwise selects a matching native binary. Manual downloads must
verify `SHA256SUMS` before execution. `manifest.json`, `SHA256SUMS`, and
`SHA256SUMS.sigstore.json` remain external so consumers can authenticate the
closed release inventory before opening either archive. Archive consumers must
reject duplicate, linked, traversing, or unexpected members before extraction.

## Release sequence

1. Update `CHANGELOG.md` and set the intended root/workspace version.
2. Run `verify:version`, privacy history, licenses, build/typecheck/tests, and
   Portable clean-environment acceptance for the three currently supported native targets.
3. Commit from a clean worktree and create the matching annotated `v*` tag.
4. Let GitHub Release and Private Cloud workflows build from the tag; do not upload local binaries.
5. Keep the GitHub Release as a draft until signatures, provenance, SBOMs,
   successful GHCR scans, all three supported native Portable clean installs/reinstalls,
   and the exact revision-bound evidence pass. Dedicated and Private Cloud
   bundles remain uncertified preview assets pending system-level acceptance.
6. Publish the draft only after the required acceptance evidence is complete.

The complete go/no-go criteria are in
[`../operations/public-release-readiness.md`](../public-release-readiness.md).
