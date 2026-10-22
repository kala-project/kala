# Private Cloud public release and operator contract

**Status:** normative release/operator contract, not a claim that a publicly downloadable candidate has passed production certification. The [design/status ledger](../architecture/private-cloud-design-status.md) separates the enterprise target, the installed default and experimental work.

New deployments should follow the [signed-release first-install guide](./private-cloud-first-install.md)
for the complete operator, identity, first owner, Executor and backup journey.

Private Cloud is the multi-tenant configuration of the self-hosted Platform. Its
public distribution is a signed, versioned Linux x64 Compose bundle plus three independent
Linux amd64 OCI images: Runtime, Stable Ingress, and Dashboard. An operator
machine needs Docker Engine with Compose v2, the downloaded bundle, deployment
configuration, and private secrets. It never needs Git, Node.js, pnpm, or source.

## Immutable release bundle

Every bundle contains `compose.yaml`, bundled storage and edge overrides (presence alone does not certify an experimental mode such as NFS),
`deployment.json`, environment examples, `image-lock.json`, `manifest.json`, and
the Linux x64 `kala-private-cloud` native executable. The repository `.mjs` entry
remains a development/test path and is rejected by release-mode verification. Linux
arm64 bundle and image publication is paused and unaccepted. The production Compose model contains
no `build:` key. Every image, including infrastructure and one-shot jobs, is a
registry name followed by an exact `@sha256:` digest. `image-lock.json` binds the
product version, revision, and Runtime, Ingress, and Dashboard digests. The bundle
manifest binds every shipped file by size and SHA-256.

`compose.dev.yaml` is a repository-only override for source builds and acceptance.
It is not a release asset and is never accepted by the public operator.

## Supported lifecycle

These are Operator command contracts; their availability is not a certification of a particular candidate's upgrade, rollback or production support. See the exact-release evidence below.

```text
kala-private-cloud install --bundle DIR --config-dir DIR
kala-private-cloud status
kala-private-cloud upgrade --bundle DIR
kala-private-cloud upgrade-dashboard --bundle DIR
kala-private-cloud rollback
kala-private-cloud backup --output EMPTY_PERSISTENT_DIR
kala-private-cloud restore --backup DIR --confirm RESTORE:<backup-id>
kala-private-cloud uninstall --confirm UNINSTALL:<installation-id>
```

The operator owns a versioned installation record, immutable copied releases, an
active image lock, one predecessor lock, and monotonic atomic operation receipts.
Install and upgrade pull by digest before mutation. A complete upgrade replaces
application services and keeps the prior image lock for one-step rollback. A
Dashboard-only upgrade replaces only `dashboard` and proves the Runtime and
Ingress container identities did not change. Rollback uses the persisted
predecessor, never a mutable tag or caller-supplied guess.

Backup records the exact active image lock and Compose project, stops application
writes, dumps PostgreSQL, archives persistent volumes, hashes each streamed artifact,
and writes the manifest last before restoring service. Restore verifies every hash
before stopping services. Lifecycle receipts use
an explicit transition graph; invalid or non-monotonic transitions fail closed.
Uninstall removes containers and operator-owned installation metadata only after an
installation-specific confirmation. Volumes, configuration, secrets, releases,
receipts, and backups are retained by default.

An individual Runtime Unit may also be exported for operator-controlled transfer.
The export contains only that Unit's directory and a manifest binding its Unit ID,
source revision, size, and SHA-256. Restore requires `runtime-host` to be stopped,
validates every archive path, and refuses to merge into or overwrite an existing
Unit. Export material must be encrypted before it leaves the trusted host.

## Runtime isolation gates

The public Gateway reaches Runtime only over TLS 1.3 with mutual certificate
authentication. Server, Gateway-client, and health-probe certificates are signed by
an installation-local CA and mounted only into the services that require them. The
application ingress secret remains mandatory as defense in depth.

Every Runtime Unit is admitted through a process-local resource governor. Concurrent
turns, durable queued messages, and artifact bytes have independent per-Unit limits;
usage is reconciled from durable queue and artifact state after loading a Unit.
Exhaustion fails closed without partially accepting a message or artifact.

Release acceptance must prove all of the following before promotion:

- a client without the internal CA-signed certificate cannot reach Runtime;
- Unit limits reject excess work without affecting a second Unit;
- Runtime restart preserves accepted queues, DAG leases, and Session cursors;
- a full backup restores in disposable volumes and a Unit export restores without
  path traversal or overwrite;
- authenticated browser and Executor journeys remain functional under the supported
  concurrency load.

## Independent Dashboard lifecycle

Dashboard has its own image digest and service. `upgrade-dashboard` may change only
that digest and container. Runtime and Ingress identities are checked before and
after the operation. Portable is the sole distribution where Dashboard assets and
Runtime share a binary lifecycle.

## Publishing and verification

Release CI currently builds only `linux/amd64` images, signs each component digest
with keyless Sigstore identity, emits OCI provenance and CycloneDX SBOMs, and then
builds the Linux x64 native-Operator Compose bundle from those digests. Linux arm64
images and Operator bundles are paused and have no acceptance claim. The tag workflow still publishes the three images and uploads signed
Compose bundles to the GitHub Release; publishing alone is **not** proof that a
specific bundle passed production acceptance. Do not promise a production-ready
Private Cloud release without a successful clean acceptance artifact for its exact
archive SHA-256 and commit.

The currently optional, non-certifying predecessor-upgrade `clean-compose-acceptance` job uses the `linux-x64` signed bundle
transferred from the same `bundle` job, and verifies its Sigstore identity. It
fetches a previously released, signed predecessor bundle, checks both bundles'
embedded revisions against their tags, then installs into an isolated Compose
project, tests two tenants, the Browser and Executor, mTLS, Unit quotas, restart
recovery, Dashboard-only/full upgrade, rollback, and backup/restore. On success it
uploads a minimal digest-bound `rc-evidence.json` Actions artifact. A skipped,
queued, or failed job produces **no passing evidence**; the existing optional
product E2E on a preinstalled deployment is not a substitute.

When executed, the beta fresh-install acceptance and optional predecessor-upgrade
job use a new GitHub-hosted `ubuntu-24.04` VM; no self-hosted runner or persistent
installation is needed. They check Docker, the browser and the VM environment
before running the actual signed-asset, browser, Executor and restore tests.

The fresh candidate job runs for every release tag and is self-contained; it
requires no repository Actions secrets or variables. Its success and digest-bound
evidence are required for promotion even when the predecessor-upgrade job is
disabled. Its explicit `--ephemeral-bundled-acceptance` path uses the verified
candidate Operator to run `init-config` with bundled identity and local-volume
storage. It starts only the signed candidate identity stack, uses the
short-lived bootstrap PAT inside the signed identity helper to create two real
verified password users, records each returned Zitadel `userId`
as that user's exact OIDC `sub`, enrolls the web client, and deletes the PAT.
The identity services are stopped without deleting their volumes; normal
candidate installation then reuses the same identity database and enrollment
files. Generated passwords, the model bearer credential, and bootstrap inputs
exist only in process memory or mode-0600 files under the disposable scratch
directory and are never uploaded.

The same fresh job runs a minimal OpenAI-compatible fixture in the candidate's
immutable digest-pinned Runtime image on the ephemeral Compose `egress` network.
The fixture accepts only the random bearer credential mounted from the protected
LLM key file, streams a real `write_file` tool call, and returns the final marker
only after the Runtime sends the matching tool result. The Browser/Executor test
still approves the tool, verifies the exact file on disk, verifies the final
answer, and reloads the Session. The fixture container is always removed. The
job also retains the two-tenant, unauthenticated-capability, mTLS rejection, Unit
quota, Runtime restart/DAG recovery, and backup/restore assertions. It fails
rather than emits passing evidence when the hosted VM has less than 10 GiB free
after removing unused preinstalled SDKs. This threshold is a fail-fast guard,
not proof of peak disk sufficiency; only a successful hosted run establishes
that for the exact candidate image sizes.

### Local published-asset replay (2026-10-21; not hosted certification)

The publicly released `v0.3.0-beta.19` Linux x64 bundle (SHA-256
`8a4f4125440d1bb5e29f112adfbedc33f46879c0326c919d733ea356783a4581`,
revision `68f81b08660cbb435386055e426425881bd3a326`) and Linux x64
Executor were downloaded and independently verified against the original
`xingsy97/kala` Sigstore workflow identities; all three locked OCI image
signatures were verified. On a local Linux host, the `--fresh-candidate
--ephemeral-bundled-acceptance` acceptance ran with Chromium and an isolated
Docker Compose project, generated `linux-x64-compose-fresh` evidence, and
passed the digest-bound evidence validator. This exercised bundled identity
users, authenticated model/tool and Executor actions, two-tenant isolation,
Runtime restart, backup/restore, and related security checks. The local Docker
project was removed. The harness needed `--same-permissions` when unpacking
under a restrictive host umask so the signed public Caddyfile retained its
archived `0644` mode. This replay is **not** a GitHub-hosted clean VM result,
not evidence for the later uncommitted changes, and not an upgrade or rollback
from a previously supported Private Cloud release.

No historical Private Cloud release is currently certified as an eligible
predecessor. The public `v0.2.0` bundle is signed but lacks the bundled-identity
assets required by the current clean-Compose acceptance contract; historical
beta.18 references likewise cannot establish an eligible release. The optional
predecessor-upgrade job therefore produces only
non-certifying migration evidence and requires a manual workflow dispatch. Set
`KALA_PRIVATE_CLOUD_UPGRADE_ACCEPTANCE_ENABLED=true`, provide `predecessor_tag`,
and set `unsupported_predecessor_override` to that exact same tag as the explicit
acknowledgement. The evidence records `certifying: false` and is not consumed by
promotion. Provide
`KALA_RC_PRIVATE_CLOUD_CONFIG_ARCHIVE_B64` as a repository Actions secret
containing a base64-encoded gzip tar archive with `deployment.env`,
`runtime-provider-catalog.json` and `secrets/` at its root (and
`identity-secrets/` when applicable). It must contain a working OIDC client,
provider configuration and keys, not placeholders. Also configure the Alice and
Bob email, password, and exact OIDC-subject secrets plus both issuer variables
used by that job. Obtain each exact issuer and `sub` from a verified ID token or
IdP administrative record; never derive or guess `sub` from email. After
installing the predecessor bundle, acceptance uses the current worktree Operator
to provision each identity as owner of a different Organization before login.
Each job uses its own disposable VM; never reuse a customer's installation or
treat preinstalled-deployment E2E as fresh acceptance. The GitHub release upload
is not gated on the optional upgrade job: check its evidence before customer
delivery.
