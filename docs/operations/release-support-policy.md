# Release and support policy

Kala is pre-1.0 software. The supported public channel is the newest stable
GitHub Release identified by one product tag, currently `v0.2.0`. A publicly
available beta asset can be signed and downloadable without being part of this
stable supported channel; see the [Private Cloud release evidence](./private-cloud-release.md)
and [design/status ledger](../architecture/private-cloud-design-status.md). Promotion
to the stable supported channel requires the three-platform Portable
install/reinstall matrix and the release asset and image security gates in
`public-release-readiness.md` to have attached evidence. Source from
an arbitrary commit, nightly artifacts, mutable container tags, and development
Compose overrides are unsupported.

Security fixes are applied to the newest stable release. There is no parallel
maintenance branch or guaranteed data/protocol compatibility between pre-1.0
releases. An upgrade that changes persisted state must ship its migration,
backup/restore procedure, and rollback boundary in the same release. The previous
immutable Dedicated or Private Cloud release is retained for the documented rollback
window; Portable users retain the previous verified executable themselves.

The supported install matrix for `v0.2.0` is Portable on Linux x64 and
macOS x64/arm64, only after each native asset has passed a clean install and
same-version reinstall on its matching runner. Linux arm64 native binaries and
Windows binaries or installers do not ship in this release. Linux arm64 installer
platform detection remains available for future releases, but native acceptance
has not passed. Public standalone Executor installers fail closed
without release signature verification. A one-time install issued by an
authenticated Host verifies the Host-served SHA-256 index, but trusts that Host
and its transport; it does not independently verify a release signature.
Do not enable the unsigned override for downloads from untrusted hosts.
Dedicated bundles and Private Cloud images are built and published through their
normal signed distribution workflows. Publishing is **not** certification:
upgrade, rollback, backup/restore, tenant isolation, and systemd/Compose
lifecycles require independent clean-environment evidence tied to the exact
release. Do not promise production support for a Dedicated or Private Cloud
candidate without that evidence. See the [Private Cloud first-install guide](./private-cloud-first-install.md)
for the operator-assisted onboarding path. Browser support targets
the current and previous major Chromium releases.

## Publicly downloadable v0.3.0-beta.19 candidate (not production-supported)

The immutable `v0.3.0-beta.1` tag remains a failed candidate: its hosted Windows
version-policy check failed before a public GitHub Release. The immutable
`v0.3.0-beta.2` tag also remains a failed candidate: its native release rejected
the separate Windows service Host as a fifth Executor, and its Private Cloud
images were blocked by the release vulnerability gate. The immutable
`v0.3.0-beta.3` tag passed native signing and Private Cloud image scans, but its
fresh identity acceptance failed on Compose `--wait` for a container without a
healthcheck; Windows acceptance revealed an empty Windows pnpm build filter, and
Portable OCI could not read the draft through GitHub's release-by-tag REST API.
`v0.3.0-beta.4` passed all four hosted Portable Host/Executor OS acceptance jobs
and the signed Private Cloud image scans, but Portable OCI candidate validation
lacked a required Node dependency and the fresh Private Cloud model fixture
could not join an egress network before installing the application. The
`v0.3.0-beta.5` candidate passed all four hosted OS acceptance jobs but its
bundled Private Cloud Operator install could not reset a network occupied by
the prematurely started test fixture. Its OCI image was signed and had a
GitHub-verifiable SLSA attestation, but the Cosign CLI did not find GitHub's
SLSA predicate through the Cosign-specific registry mechanism. All five tags
remain unsupported and must not be promoted. `v0.3.0-beta.6` completed the
four hosted Portable Host/Executor OS acceptance jobs, but its fresh Private
Cloud browser could not establish an Alice session within the login timeout;
its Portable OCI dual-scanner gate found numerous unapproved HIGH/CRITICAL
findings in the full Debian/npm base. Beta.6 also remains an unsupported draft
and must not be promoted. The `v0.3.0-beta.7` candidate passed all four hosted OS acceptance jobs
and real image dual-scanner policy. Its Private Cloud fresh install reached
authenticated Alice login and Executor invitation, then failed on a test-harness
workspace variable scope error before the full workspace and restore checks.
Its OCI image passed signing, provenance, SBOM, and real dual scanning, but the
hosted Docker test could not establish a WebSocket session. Beta.7 remains an
unsupported draft. `v0.3.0-beta.8` again passed four hosted OS acceptance
jobs and the real dual-scanner image gate. Private Cloud reached tenant,
workspace and runtime-gate checks, then failed on a missing test-harness
Socket.IO event helper. OCI Docker acceptance confirmed that a randomly
assigned external port was rejected by the product's strict public-origin
gate with HTTP 403. Beta.8 remains an unsupported draft. `v0.3.0-beta.9` passed all four hosted
OS jobs, Portable OCI real dual scanning, signed supply-chain checks, and
GitHub-hosted Docker Session persistence across container replacement. Its
Private Cloud fresh install progressed through tenant isolation and full
workspace to Runtime restart recovery, where its test fixture requested two
queued messages while its configured per-Unit queue limit was one; the second
message was correctly rejected. Beta.9 remains an unsupported draft. `v0.3.0-beta.10` passed all four hosted
OS jobs and the OCI image's real dual scanners, signatures and Docker
Session-persistence lifecycle. Private Cloud reached a successful two-message
queue, but exposed a product defect: `client:initialize_dag` persisted a
ready node without starting its scheduler; the required pre-restart DAG lease
never appeared. Beta.10 remains an unsupported draft. `v0.3.0-beta.11` passed the four hosted
OS jobs, real Portable OCI vulnerability scanners and Docker persistence. Its
Private Cloud candidate did produce a pre-restart DAG lease, proving that the
production scheduler fix reached the signed image; however, the E2E fixture
then waited on DAG scheduling after starting a timed shell command, and its
queued marker executed before Runtime was restarted. The recovery invariant
was not proved. Beta.11 remains an unsupported draft. `v0.3.0-beta.12` passed four OS and
Portable OCI hosted acceptance. Private Cloud progressed beyond the
pre-restart queue and DAG checks, but the first authenticated Socket.IO
connection attempted immediately after Runtime's HTTP health recovered
failed before `session:ready`. Actual queue/DAG recovery and backup/restore
were not proved. Beta.12 remains an unsupported draft. `v0.3.0-beta.13`
passed four hosted OS jobs and Portable OCI signing, dual scanning and Docker
Session-persistence acceptance. Its Private Cloud fresh-install gate stopped
before restart: the acceptance harness incorrectly required Kernel JSONL
history events from an external Runtime that instead persists Session state
projections. Queue recovery and backup/restore were not proved. Beta.13 remains
an unsupported draft. `v0.3.0-beta.14` built 32 signed draft assets
and passed the Private Cloud image vulnerability gate, but its fresh-install
run timed out waiting for a baseline shell-result projection plus a model
turn in `done` status. The log did not establish which condition was missing;
restart recovery and backup/restore were not tested. Beta.14
remains an unpublished, unsupported draft. `v0.3.0-beta.15` passed all four
hosted OS acceptance jobs and Portable OCI signing, dual scanning and isolated
Docker Session-persistence acceptance. Its Private Cloud fresh-install run
observed two external Runtime projections ending in `error`, but no completed
baseline shell result before the restart boundary. The shell/Runtime failure
cause was not established, and backup/restore was not tested. Beta.15 remains
an unpublished, unsupported draft. `v0.3.0-beta.16` passed four hosted OS
jobs and Portable OCI dual scanning, signing and Docker acceptance. Its Private
Cloud fresh-install run persisted and reloaded a nonzero Session projection,
but the queued shell marker was absent from the first post-restart queue
snapshot; recovery and backup/restore were not proved. The shell-based timed
fixture did not give a reliable in-flight boundary. Beta.16 remains an
unpublished, unsupported draft. `v0.3.0-beta.17` passed four hosted OS
jobs and Portable OCI signing, dual scanning and Docker acceptance. Its Private
Cloud fresh-install workflow observed a hydrated queue, non-regressing Session
cursor, completed model reply and recovered DAG query, but stopped before the
final evidence assertions on a test-harness mistake: it expected
HTTP 200 for Bob's successful attachment creation, while the product correctly
returns HTTP 201. The final quota report and backup/restore gate were not
accepted, so beta.17 remains an unpublished, unsupported draft. The `v0.3.0-beta.18` record is retained as an unsupported historical candidate;
its existence or built assets do not establish acceptance or support. No Private
Cloud predecessor is currently certified. A manual migration experiment against
an historical candidate must use the workflow's exact-tag
`unsupported_predecessor_override`; its evidence is marked `certifying: false`
and cannot substitute for mandatory fresh-candidate evidence. Canonical package
metadata and the exact-tag Portable OCI workflow now identify
`v0.3.0-beta.19` as the active candidate. Its signed Linux x64 Private Cloud
bundle is publicly downloadable and passed a local fresh-install replay; that
is **not** a passing hosted clean-VM certification or production support for
beta.19. The local evidence and its exact revision are recorded in the
[Private Cloud release document](./private-cloud-release.md).
Its proposed default asset contract is Linux x64 and macOS x64/arm64
OS-native Executor plus Node.js 22+ CJS Portable Host and Dedicated components. Host and Dedicated
self-contained native binaries are only manual qualification artifacts, not
part of the signed default inventory. The Private Cloud signed bundle contains a Linux x64 native Operator and its
three images are Linux amd64 only; Node.js is not required on the installation
host. Linux arm64 Operator bundles and images are paused and unaccepted. The
default is single-host `local-volume` storage. Local NFS requires an explicit
experimental choice; there is no full-stack NFS acceptance evidence. Windows x64 Portable Host CJS
and OS-native Executor with ConPTY are separate pending runner gates and must
not be advertised as shipped until both their actual assets and end-to-end
results pass. For the candidate, Windows Host is **Node.js 22+ CJS**, not an
OS-native Host `.exe`: its matching `kala-copilot-runtime-win32-x64` and
`kala-copilot-runtime-node-win32-x64.node` must be distributed alongside it.
Windows Executor is the default OS-native `kala-executor-win32-x64.exe`,
with the matching `node-pty-win32-x64.tar.gz` ConPTY companion and
`install-executor.ps1`. A standalone Host CJS download alone does **not**
contain the signed Windows Executor/ConPTY installer: Host-mediated Windows
installation stays disabled until the Host can serve these adjacent assets
with matching SHA256SUMS entries from the exact release. Acceptance must
cover both a fresh Windows Host and the native Executor temporary/service
terminal lifecycles using the downloaded release assets, not merely a
source checkout.

Earlier candidates passed signed Portable OCI scanning and hosted Docker
acceptance, but beta.19 must independently pass its exact-digest gates and
anonymous full pulls before promotion to the stable supported channel. Public
beta asset availability alone does not satisfy these gates. None of these candidate policies
retroactively alters the `v0.2.0` support claim above.

### Release-state and acceptance contract

These states are deliberately separate:

- **Built** means a workflow produced an asset. It makes no install, runtime,
  publication, or support claim.
- **Accepted** means the exact checksummed and attested candidate assets passed
  the matching clean-runner contract. Acceptance evidence is target-specific and
  does not transfer between Linux, macOS, Windows, or OCI.
- **Publicly available** means an immutable asset or image can be fetched without
  release-author credentials. Availability is not acceptance.
- **Supported** means this policy names the release and platform in the supported
  matrix. A draft, prerelease, experimental option, or manually qualified asset
  remains unsupported even if it was built or accepted.

For Linux x64 and macOS x64/arm64 Portable, `rc-acceptance.yml` now requires the
exact CJS Host and matching OS-native Executor from the candidate release. On the
matching hosted runner it submits a real Dashboard protocol message to the native
Executor, runs a local terminal command, writes and reads a workspace file,
checks the persisted terminal result, gracefully checkpoints the Host, replaces
and restarts the CJS and Executor, reloads the Session, reads
the pre-restart file in a second terminal command, and then performs a clean
stop. With no distinct `--predecessor-asset`, this proves a **same-version
reinstall**, not a predecessor-to-candidate upgrade. A real upgrade claim still
requires a separately supplied, verified predecessor asset and explicit
migration/rollback evidence.

Windows acceptance is a separate real `windows-latest` gate over the downloaded
Node.js 22 CJS Host, native Executor, ConPTY companion, installer, service Host,
and Copilot runtime companions. It covers temporary and service terminal
lifecycles. A Linux run cannot substitute for that evidence. The acceptance
message intentionally uses the explicit shell intent and no model provider, so it
proves local product messaging and native execution without claiming Anthropic,
Copilot, or other external provider authentication. Portable OCI remains a
separate exact-digest isolated-VM and anonymous-pull contract.

Local NFS, self-contained native Host qualification artifacts, and any platform
not named in the supported matrix are experimental or manual qualification
surfaces, not supported defaults.

Report vulnerabilities privately through `SECURITY.md`. General defects use the
public issue templates and must contain synthetic, redacted evidence. Release assets use the repository, issue tracker, and documentation links
embedded in their metadata; no private installation data is accepted as public evidence.
