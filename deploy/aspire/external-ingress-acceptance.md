# External ingress and application-only cold recovery — 2026-10-29

**Passed: frozen source `069e6172`, real five-service external-ingress installation, independent verified HTTPS/WebSocket proxy and artifact-v3 three-root recovery.** This is local Linux integration evidence, not a supported production release. The [deployment contract](../../docs/architecture/deployment-mode-contract.md) remains authoritative; [machine evidence](./external-ingress-acceptance.json) binds images, source hashes and phases.

## What actually ran

Runtime and Gateway were built from `git archive 069e617228d439a7fb3f1c57bafaeac9047b9f8c`, including the earlier `b2a8ee03` indeterminate-timing correction. No workspace, SDK HOME or Session tree was copied into either build.

- Runtime: `kala-dedicated-ingress-runtime@sha256:d886d1a221f7869dd1db3a86a1646d74524cf5ec4c772b1cb51dfce0111e2e97`
- Gateway: `kala-dedicated-ingress-gateway@sha256:ab447dabe0ec3b5f5cb9b4fb4aa0000933885a041dde578ffb3ad55d062bf0c8`

The unchanged product Dashboard image was reused; exact PG/SILO/Dashboard references are in the machine record. Official Aspire publication created five containers: Gateway, Runtime, product Dashboard, PostgreSQL and SILO. There was **no Caddy container or application-owned named volume**. Gateway's HTTP listener was published only on IPv4 loopback.

A separate synthetic operator-owned Node HTTPS/WebSocket proxy terminated TLS and forwarded to that handoff. Its freshly generated certificate/private key stayed outside the recovery root. This is a local trusted synthetic certificate, not public ACME/DNS issuance or renewal evidence. Neither HTTP nor WebSocket clients disabled TLS verification.

## Real lifecycle assertions

1. Initialization without `--acknowledge-external-ingress-fenced` failed before creating any container. With the independently absent/fenced proxy and acknowledgment, initialization and explicit initialized continuation succeeded; all five actual services became healthy.
2. The independent proxy served verified HTTPS; Owner login and `/auth/me` succeeded, as did a cookie-authenticated Dashboard WebSocket connection.
3. Independent SQL and S3 markers were written. Backup without the external-fence acknowledgment failed without stopping the running services or creating an artifact.
4. The proxy was actually stopped and its port proved closed. Production `backup.sh`, with acknowledgment, cold-stopped application writers and cleanly stopped the data authorities. Artifact v3 contained exactly `postgres`, `silo`, and `recovery`, with `external-not-in-app-backup` custody and no Caddy provenance or external PKI files.
5. Production `recovery.sh` refused the missing external acknowledgment, then restored to three fresh, root-private disjoint directories under an exact same-image/no-migration policy. It reported `ingressIdentity: external-not-restored` and started no services.
6. Explicit operator startup made the restored five-service graph healthy. The independent proxy was restarted using its separately retained original certificate. The original verified TLS context and opaque Owner cookie remained valid; SQL/S3 markers were byte-exact and authenticated WebSocket connection succeeded again. **Application restore did not restore TLS.**

Root Python discovery passed all 37 existing cases without skips; shell syntax, actual AppHost build and [official four-profile publication](./ingress-profile-acceptance.md) passed. The known ASPIRE010 warning remains visible.

## New-image observability, separate from model work

A separate real Collector/Aspire Dashboard run imported the packaged timing tracker, bridge and telemetry client from this frozen Runtime image. A frozen synthetic structured indeterminate receipt retained its business outcome and projected interrupted timing; the actual backend returned anonymous Agent parent/child spans including `execution.state=unknown`. Authentication, metrics/logs, sensitive-field exclusion and the existing bounded stopped-backend check passed. The latter remains a host-client component check; it is not claimed as an image shutdown test.

These are **synthetic timing inputs**, not a real provider, native SDK, child Agent or remote Executor turn. The current process had no `COPILOT_GITHUB_TOKEN`, `GH_TOKEN` or `GITHUB_TOKEN`; the existing CLI configuration was not a usable JSON credential reference. No credentials were refreshed, no login was attempted, and no existing token's validity or expiry was inferred.

## Evidence boundaries and remaining gates

- External eight-resource and bundled six/nine-resource shapes passed official publication/topology checks. This new running application/recovery slice is the external **five-service** profile, not external eight-resource full-stack recovery or bundled-v3 PKI recovery.
- Earlier bundled nine-resource/five-root v2 evidence remains version-bound to `1e6fd5bd`; its packaged Owner change/reset and distinct historical upgrade results are not silently attributed to these new images.
- Latest-image real model/SDK/remote Executor/child work, continuous infrastructure metrics/history/alerts, logical WebSocket/native distributed tracing, generic credential/state-key rotation, arbitrary schema/PG-major migration, public certificate renewal, hardening/soak and signed releases remain open.
- All work is local. Existing deployments, LXD/IdP, real Workspace/Session state and unrelated main-worktree changes were not modified. Fixture containers were stopped/removed after the assertions; scoped secret-bearing fixture cleanup is recorded separately.
