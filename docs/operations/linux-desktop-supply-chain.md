# Linux desktop supply-chain assessment (2026-09-12 UTC)

## Examined official versions

These are exact pins, not unchecked `latest` selections. New Rust dependencies
are from the official crates.io registry, with checksums in Cargo.lock. The only
new JavaScript dependency is the official Tauri CLI, whose platform binary is
integrity-locked in pnpm-lock.yaml. The launcher itself has no JS dependencies.

| Component | Pin | Official release date | Age at review | Rationale |
| --- | --- | --- | --- | --- |
| `tauri` | 2.11.5 | 2026-07-01 | 73 days | Reviewed maintenance patch; removes obsolete time upper-bound after upstream fix |
| `tauri-build` | 2.6.3 | 2026-06-17 | 87 days | Matching official stable build crate |
| `@tauri-apps/cli` | 2.11.4 | 2026-06-28 | 76 days | Stable official CLI/native bundler; exact npm integrity lock |
| `gtk` | 0.18.2 | 2024-12-09 | 642 days | The GTK3 binding required by official Tauri Linux; reused for explicit save confirmation |
| Rust | 1.93.1 | 2026-02-12 | 212 days | Exact mature compiler supporting locked transitive MSRVs |
| `cargo-audit` (verification tool only) | 0.22.1 | 2026-02-04 | 220 days | Official RustSec binary; SHA-256 verified before execution |

Primary sources:

* https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.11.5
* https://github.com/tauri-apps/tauri/releases/tag/tauri-build-v2.6.3
* https://registry.npmjs.org/@tauri-apps/cli (version timestamps and dist integrity)
* https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri/CHANGELOG.md
* https://static.rust-lang.org/dist/channel-rust-1.93.1.toml
* https://github.com/rustsec/rustsec/releases/tag/cargo-audit/v0.22.1

The cargo-audit Linux GNU archive verified against the GitHub release asset digest:
`1890badd5f15831a9af4b074399fcd21e6f7c0fe42c84e9254cdffc9f813765c`.

## Important Tauri origin advisory

Official advisory
[GHSA-7gmj-67g7-phm9](https://github.com/tauri-apps/tauri/security/advisories/GHSA-7gmj-67g7-phm9)
affects Tauri 2.0 through 2.11.0; patched in 2.11.1. This matters especially for
our remote-first architecture. **Do not downgrade below 2.11.1.** The selected
2.11.5 contains the fix. Real WebKit testing additionally confirmed remote
`connect` invocation fails with `Command connect not allowed by ACL`.

## Audit findings and production blockers — not a clean security attestation

The resolved Rust lock was scanned with cargo-audit 0.22.1 against RustSec commit
`b50980aad8b8f14f77e25a97b32dd94bf008b0af` (1,243 advisories; last updated
2026-09-09). Cargo-audit reported **zero entries in its vulnerability category**,
but **one unsoundness warning and six unmaintained warnings**. Those distinctions
must not be hidden behind a “zero vulnerabilities” claim.

* **RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g**, `glib` 0.18.5:
  unsound `VariantStrIter` iteration can cause undefined behavior/null-pointer
  crashes in optimized builds. Fixed in glib >=0.20.0, which is not
  dependency-compatible with Tauri's GTK3 0.18 stack. Application code does not
  call this iterator, but this is **not proof that every transitive path is
  unreachable**. No unofficial fork or unreviewed patch is silently substituted.
  This prevents claiming the requested completely advisory-free native
  dependency graph. Production APT publishing is gated on an audit with
  `--deny unsound`; this candidate does not pass that stricter gate.
* Unmaintained: `proc-macro-error` 1.0.4, `unic-char-property` 0.9.0,
  `unic-char-range` 0.9.0, `unic-common` 0.9.0, `unic-ucd-ident` 0.9.0 and
  `unic-ucd-version` 0.9.0. These are upstream Tauri/GTK/build transitive choices,
  not newly selected alternative libraries. Track upstream replacement.
* The **existing workspace** pnpm audit reports 48 advisories: 1 critical,
  17 high, 25 moderate, 5 low. Findings include existing Vitest/Vite development
  tooling and Dashboard Mermaid/DOMPurify/Socket.IO transitive dependencies.
  No new advisory is attributed to the Tauri CLI. The remote Dashboard remains
  the server's existing deployment, not a frozen vulnerable copy in the package.
  These inherited findings still require a separate assessed upgrade effort;
  do not mistake the desktop delivery for remediation of the entire workspace.

The downloadable `.deb` is explicitly an **unsigned, review-required candidate**.
Checksums detect corruption, not publisher authenticity. Production signing key,
trusted HTTPS APT hosting, independently distributed fingerprint, and resolution
of the native strict-audit blocker are outstanding. Do not advertise automatic
APT updates as live until all are satisfied.

## Revalidation

The `0.3.0` preview was built in the existing isolated Ubuntu 24.04 builder
from signed source revision `78bfd20413628445c3bf074ea758fc1209c8148f`
with frozen pnpm and Cargo locks. A fresh strict RustSec audit on 2026-11-04
found both `RUSTSEC-2024-0429` (`glib` 0.18.5) and
`RUSTSEC-2026-0386` (`tokio` 1.53.1) as unsoundness warnings. The pnpm audit
reported 17 additional low/moderate advisories. This unsigned preview has
not passed the production publishing gate; making it downloadable for
testing does not confer security approval or publisher authentication.

```sh
pnpm install --frozen-lockfile
pnpm audit --json
cargo audit --file packages/desktop/src-tauri/Cargo.lock --deny unsound
pnpm --dir packages/desktop/src-tauri exec cargo test --locked --release
pnpm --filter @agent-kernel/desktop build
```

Retain raw audit output with the build's lock hashes. Runtime WebKitGTK and GTK
security patches come from the user's distribution (`apt update` / `apt upgrade`);
they are deliberately not vendored in the desktop package. Revalidate source
releases, checksums, advisory database freshness, and system packages for every
published candidate.

## Artifact-bound publication (release-integrity correction)

Production publication now requires the controlled builder's owner-only local
receipt and verifies the exact `.deb`, captured dependency manifest and every
lock/input digest. Audit targets are
`packages/desktop/.build-provenance/<deb-sha256>/Cargo.lock` and the corresponding
captured pnpm lock, **never an unrelated current checkout**. Both native
`--deny unsound` and pnpm `--audit-level low` gates fail closed; existing findings
are not grandfathered into signed production releases.

The corrected `0.2.0~rc.1` artifact was independently rebuilt and its actual lock
still fails strict native audit. Local signed-APT mechanics were tested only
with an ephemeral TEST ONLY key in the disposable builder. This deliberately
does **not** constitute production security approval, key custody, public hosting
or publisher-authenticated provenance. See the release operations and updated
delivery evidence for immutable metadata URLs and exact artifact identity.
