# Private Cloud: first installation from a signed release

This is an **operator-assisted** Linux installation, not a source-checkout workflow. Use only a signed bundle that actually contains the bundled-identity assets. The signed `v0.3.0-beta.19` Linux x64 assets are publicly downloadable and passed a **local** isolated fresh-install replay, but are not production-supported or certified by a successful GitHub-hosted clean-VM run. That replay also does not cover later uncommitted changes. See the [exact evidence and limitations](./private-cloud-release.md#local-published-asset-replay-2026-10-21-not-hosted-certification), [support policy](./release-support-policy.md), and [design/status ledger](../architecture/private-cloud-design-status.md). Never experiment on an existing customer Compose project.

**Scope warning:** this is the published legacy single-machine installer, not the [node-independent Private Cloud deployment target](../architecture/private-cloud-enterprise-architecture-contract.md#private-cloud-persistence-and-deployment-invariant). It stores authoritative Runtime data and an embedded PostgreSQL database on one machine. Do not present these instructions as a recommended scalable/HA or new enterprise production installation. The external-PG/S3 source profile is still an evaluation, not a signed replacement; there is no safe in-place conversion from these volumes. Preserve existing installations and backups while the supported migration and release path is built.

## Legacy quick path: one configuration, one check-and-install

After verifying a compatible signed bundle (section 1) and granting the target Docker daemon access to the three immutable Kala images, prepare one version-1 provider catalog JSON with a real reachable model endpoint and one private (`0600`) file containing its API key. The installer supplies local PostgreSQL, a single-host persistent Docker volume, internal mTLS, random secrets and bundled ZITADEL in the **same Compose project** as Runtime Host, Ingress and Dashboard. The signed beta.19 bundle contains a Linux x64 native Operator, so Node.js is not required on the deployment machine; Linux arm64 is paused and is not an accepted release target. It does not require DNS, public HTTPS or Cloudflare Tunnel.

```bash
./private-cloud-bundle/kala-private-cloud setup \
  --bundle "$PWD/private-cloud-bundle" --config-dir "$PWD/private-cloud-config" \
  --provider-catalog "$PWD/my-model-catalog.json" \
  --llm-api-key-file "$HOME/private/model-api-key"
```

`setup` validates inputs and permissions before generating configuration, then checks Compose and deploys automatically. Errors stop with a nonzero exit code; run the **same** command after correcting the cause. Existing identity secrets and registered OIDC credentials are retained, not regenerated. The bootstrap administrator password is in the owner-only `private-cloud-config/identity-secrets/initial_human_password` file: never print it into logs or send it through tickets, and change it on first ZITADEL sign-in. The bundled installer prefers Kala `http://localhost:13001` and identity `http://localhost:13002`, but if either port is occupied it selects an available loopback pair (currently `13101/13102`, then `13201/13202`) **before** persisting the configuration. Read the actual `kalaUrl` and `identityUrl` from the command output and `deployment.env`; never stop an existing service (for example a documentation site already on `13001`). You may instead choose both ports at first installation with `--app-port 13101 --identity-port 13102`. The beta default `local-volume` keeps data on this one Docker host: arrange durable backups and do not treat it as replicated storage. NFS is an explicit experimental `--storage nfs` choice, not covered by full-stack acceptance. If selected, its listener stays on loopback and prefers `12049`, then `12149/12249` when occupied; read the saved `nfsPort` rather than disrupting another project's NFS server. You can choose `--nfs-port` only with NFS. An already configured issuer, redirect URI, or storage mode cannot silently move. Both loopback endpoints are accessible only from the installation machine (or a trusted local port forward), not from another user's browser. A successful container health check is **not** proof of a working browser login.

For an existing OIDC provider, register `http://localhost:13001/auth/callback` for **local** usage only when `13001` is genuinely free. If occupied, choose a free `--app-port` **before** registering the external IdP client and use `http://localhost:<app-port>/auth/callback` instead; external OIDC setup never changes this callback automatically. Supply the provider's exact HTTPS issuer, discovery origin, client ID and secret once. Store both client values in owner-only files; for remote HTTPS deployment use the separately registered public callback and explicitly reviewed origin/configuration instead. The same installation entry point accepts:

```bash
./private-cloud-bundle/kala-private-cloud setup \
  --identity external --bundle "$PWD/private-cloud-bundle" \
  --config-dir "$PWD/private-cloud-config" \
  --provider-catalog "$PWD/my-model-catalog.json" \
  --llm-api-key-file "$HOME/private/model-api-key" \
  --oidc-issuer 'https://id.example.org' \
  --oidc-discovery-origin 'https://id.example.org' \
  --oidc-client-id-file "$HOME/private/oidc-client-id" \
  --oidc-client-secret-file "$HOME/private/oidc-client-secret"
```

**First owner is a separate trusted confirmation, not the first visitor.** Use `create-owner-bootstrap` (section 3) with the bundled issuer shown in `deployment.env` (`OIDC_ISSUER`), the initial ZITADEL human account's *verified email* (on a fresh default instance, check `zitadel-admin@zitadel.localhost` in the identity Console), the organization/contract details and a future contract end date. Open its one-time URL on the installation machine, sign in at ZITADEL, inspect the resulting issuer/sub/email with `owner-bootstrap-status`, then use `confirm-owner-bootstrap` only after independent verification. The owner can then sign in to Kala, connect an Executor and create a Session. No known default administrator password is used. The setup command does not automatically grant owner rights.

**Do not forward only Kala's port to other users.** Bundled identity has a persisted `localhost` issuer (with the chosen port), so a remote browser would point at *its own* machine. Kala does not install or manage Cloudflare Tunnel/Nginx; external publishing requires a separately designed HTTPS address for **both** Kala and identity, correct OIDC redirect registration and an identity/issuer migration that preserves `(issuer, sub)` membership. Automatic migration has **not** been implemented. Do not expose the loopback HTTP listener publicly or assume wrapping one port in TLS is sufficient.

`backup` now includes the bundled ZITADEL PostgreSQL dump and its bootstrap/config volumes along with Kala's data; keep the full `private-cloud-config` (especially `identity-secrets`, OIDC client credentials and internal CA) securely backed up **separately** and restore it with the same identity database. Existing backups made without an identity dump cannot restore bundled users. Earlier isolated local-volume tests covered real browser login, first-owner confirmation, backup/restore and Dashboard-only upgrade/rollback; these are not certified predecessor→candidate upgrades. Separately, the publicly signed beta.19 asset passed a local fresh replay with bundled identity, a model fixture/tool call, Executor, two Organizations, restart and backup/restore as recorded in the [release evidence](./private-cloud-release.md#local-published-asset-replay-2026-10-21-not-hosted-certification). Experimental NFS subnet/server/initialization/tenant-data-mount tests are not a combined fresh NFS installation. Real external OIDC login, a customer-approved model endpoint, a successful hosted clean-VM run on the final candidate and a supported-predecessor upgrade/rollback still require their own evidence. The presence of a signed public beta is not production certification.

The sections below document the advanced, operator-assisted **external OIDC / published HTTPS** workflow and its legacy individual commands; they are not prerequisites for the default local path.

## 0. Decide who owns each step

| Responsible party | Before installation |
| --- | --- |
| Deployment operator | Dedicated Linux x64 host, Docker Engine and Compose v2, registry access, persistent space, backup target, DNS/TLS ingress and an OIDC client. Configure external/independent IdP, model endpoint and credentials. Linux arm64 is paused and unaccepted. |
| Identity administrator | Register the exact public OIDC issuer and the Kala callback `https://<kala-domain>/auth/callback`. Supply the first owner's **real `sub` claim** from the IdP; email is not a substitute. Enable `email_verified: true` for members accepting invitations. |
| Organization owner | Sign in only after provisioning; copy member invitations and Executor install instructions. |

Older release bundles contained the application but not bundled ZITADEL. The new bundled-identity candidate adds its own signed Compose assets and images; only use it when the **actual signed release** contains and verifies them. You can instead use an existing compatible OIDC provider; for the separate development Identity stack, see [Identity README](../../deploy/identity/README.md). In the externally published HTTPS mode, `KALA_PUBLIC_URLS`, `OIDC_ISSUER` and `OIDC_DISCOVERY_ORIGIN` must match your real TLS and OIDC topology. The `cloudflare` profile assumes the published app origin is routed to the local ingress port; plan ingress and network isolation before pulling images. Protect the Docker daemon and config directory as sensitive administrative access.

## 1. Download and verify the exact release

Use a release for which the Private Cloud bundle and signature are actually listed. Substitute the repository and tag shown on your GitHub Release; do **not** treat a GHCR image tag as an installation bundle or a successful acceptance run.

```bash
export REPOSITORY='<owner>/<repository>' TAG='v<version>' TARGET='linux-x64'  # the only current Private Cloud release target
mkdir -p ./private-cloud-download ./private-cloud-bundle
GH_REPO="$REPOSITORY" gh release download "$TAG" -D ./private-cloud-download \
  -p "kala-private-cloud-${TAG#v}-${TARGET}.tar.gz" \
  -p "private-cloud-${TARGET}.sigstore.json"
archive="private-cloud-download/kala-private-cloud-${TAG#v}-${TARGET}.tar.gz"
cosign verify-blob --bundle "private-cloud-download/private-cloud-${TARGET}.sigstore.json" \
  --certificate-identity "https://github.com/${REPOSITORY}/.github/workflows/private-cloud-release.yml@refs/tags/${TAG}" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com "$archive"
tar -xzf "$archive" -C ./private-cloud-bundle
```

Do not proceed if any asset is absent, the signature identity differs, or the local architecture is wrong. Keep the verified archive, signature and tag with deployment records. For enterprise production promises, also check the same archive SHA-256 and commit in a **successful** clean-Compose acceptance artifact; a skipped job or published image is not passing evidence.

**Check registry access before booking an installation window.** The archive contains immutable references to three GHCR images, not the image layers. On the target Docker host, use an approved account with `read:packages` access to *all three* Private Cloud packages (including package-level access granted to this repository or customer account if the packages are private), then log in interactively with `docker login ghcr.io -u '<approved-username>'`. The `doctor` step below performs a real `docker pull` of **each** `runtime`, `ingress`, and `dashboard` digest from `private-cloud-bundle/image-lock.json`; a pass therefore applies to the Docker daemon selected by that terminal, not merely to the release download account. Do not put a registry token into `deployment.env`, commit it, pass it to `doctor`, or paste it into a support ticket. If any digest returns `unauthorized`, obtain access or a separately verified customer-accessible digest-pinned mirror first. `preflight` checks Compose syntax but **does not** pull images, and `install` will fail before starting services. An authenticated GitHub Release download does not imply GHCR access.

## 2. Prepare configuration and external services

Run the bundled Linux x64 native Operator from an independent administrative terminal:

```bash
./private-cloud-bundle/kala-private-cloud init-config \
  --bundle "$PWD/private-cloud-bundle" --config-dir "$PWD/private-cloud-config" --profile cloudflare --identity external
```

The command creates owner-only configuration, randomly generated local credentials and internal mTLS certificates. It **does not** create an IdP client or usable LLM credentials. Edit `private-cloud-config/deployment.env` with the real public app URL, OIDC issuer, discovery origin, selected storage profile and Compose project name. Replace only the placeholder `private-cloud-config/secrets/oidc_client_id`, `oidc_client_secret` and `llm_api_key` files with actual values; keep each secret file `0600` and `secrets/` `0700`. Replace every example provider endpoint in `private-cloud-config/runtime-provider-catalog.json` with a reachable, authorized model service and check its default model. Never commit, paste into support tickets or print the secrets or the private config directory.

By default, OIDC HTTPS uses the system CA set in the Ingress image and no extra trust is configured. If—and only if—the independent IdP certificate chain terminates at an enterprise private CA, install its public CA chain explicitly:

```bash
install -m 0600 '<approved-public-ca-chain.pem>' private-cloud-config/oidc-ca.pem
./private-cloud-bundle/kala-private-cloud preflight \
  --bundle "$PWD/private-cloud-bundle" --config-dir "$PWD/private-cloud-config"
```

`oidc-ca.pem` may contain one or more PEM-encoded CA certificates (root and required intermediates), but no leaf certificate, private key or unrelated text. The operator rejects symlinks, group/other access and private-key material. When the file is present, the manifest-protected `compose.oidc-private-ca.yaml` copies it through the existing protected initialization path and extends Node's system trust only for `runtime-ingress`; Runtime, Dashboard and other services do not receive it. Removing the file explicitly disables the override on the next lifecycle operation. Never use `NODE_TLS_REJECT_UNAUTHORIZED=0`, replace the release override, or alter a signed bundle to bypass certificate validation. A normal full or Dashboard-only upgrade automatically applies the candidate bundle's protected override.

If your IdP is itself deployed on this machine, bring it up and verify its public issuer and callback first. Its lifecycle and backups are independent of Kala. Local HTTP and local storage modes are for a deliberately local environment, not a shortcut to an internet-exposed deployment. For external NFS, provide an actual operator-managed endpoint and test its permissions and recovery separately.

```bash
./private-cloud-bundle/kala-private-cloud preflight \
  --bundle "$PWD/private-cloud-bundle" --config-dir "$PWD/private-cloud-config"
./private-cloud-bundle/kala-private-cloud doctor \
  --bundle "$PWD/private-cloud-bundle" --config-dir "$PWD/private-cloud-config" \
  > private-cloud-doctor.json

# Only after reviewing an intentional enterprise-internal endpoint, repeat once per exact origin:
./private-cloud-bundle/kala-private-cloud doctor \
  --bundle "$PWD/private-cloud-bundle" --config-dir "$PWD/private-cloud-config" \
  --allow-private-origin 'https://idp.internal.example' \
  --allow-private-origin 'https://models.internal.example' \
  > private-cloud-doctor.json
```

Preflight checks bundle integrity, required files/permissions, remaining placeholders, availability of Kala, identity and local-NFS ports for a new installation, Docker and Compose syntax. It does not make external network requests. A port can still be claimed between the check and Docker binding; investigate that failure without stopping unrelated services. Run `doctor` from the target Docker host after registry login and while the configured external endpoints are available. Its JSON `checks` independently report `pass`, `fail`, or `manual`, a non-secret target, a message, and a remediation; the process exits non-zero if any item is `fail`. Review every `manual` item rather than treating overall `ok: true` as proof of that item.

`doctor` really pulls all three pinned image digests; fetches OIDC discovery and JWKS using `OIDC_DISCOVERY_ORIGIN` with the same public-issuer host hints as Ingress; and validates DNS/network/trusted TLS for HTTPS public and model base URLs. Targets that resolve to loopback or private addresses are not requested by default and are reported `manual`; metadata, link-local, reserved and other forbidden addresses fail without a request. `--allow-private-origin` is an explicit, auditable exception: each value must be a clean HTTPS origin that exactly matches the configured discovery origin, a `KALA_PUBLIC_URLS` origin, or a model `baseUrl` origin. Repeat it only for reviewed enterprise endpoints; it cannot authorize a discovered URL or any forbidden address. DNS answers are checked before use, the connection is pinned to those answers and the connected address is checked again. Redirects are not followed.

A same-issuer `jwks_uri` is reached only through the configured discovery topology. A cross-origin JWKS may be checked only when it resolves entirely to public addresses; a private/special-use cross-origin JWKS fails closed even if that origin was separately allowed for a configured model. Reports show URL origins only, never paths, queries, fragments or URL credentials.

If `oidc-ca.pem` is configured, it extends normal trust only for the OIDC checks, matching the deployment's private-IdP intent. A private-CA model can be checked with its approved CA in the operator process's normal Node trust (for example, `NODE_EXTRA_CA_CERTS=/protected/model-ca.pem`); certificate and hostname verification remain mandatory. The model probe is an unauthenticated `HEAD` request: it does not read or transmit `llm_api_key` and does not call a completion/inference API. Non-HTTPS/local endpoints, unauthorized private endpoints, and checks blocked by a failed prerequisite are `manual`, never `pass`. Do not use disabled TLS verification to turn a failure into a pass.

Neither preflight nor doctor proves the OIDC client registration, redirect URI/callback, authorization-code exchange, user claims, model credentials, model ID, billable inference, backup target, or application behavior after installation. Fix failures before installation; do not bypass them by copying development `.secrets` into production. After installation, a real browser login/callback smoke test and a deliberately authorized prompt/inference smoke test are still required.

## 3. Install, provision owner, and prove login

```bash
./private-cloud-bundle/kala-private-cloud install \
  --bundle "$PWD/private-cloud-bundle" --config-dir "$PWD/private-cloud-config"
./private-cloud-bundle/kala-private-cloud status
```

Only after the application reports healthy services, provision the first organization. Two paths are supported. The optional trusted-operator bootstrap avoids manually transcribing `sub`, but it **never makes the first person to sign in an owner**. On the installation host, create a 15-minute authorization bound to the configured issuer, expected verified email, organization, and contract:

```bash
./private-cloud-bundle/kala-private-cloud create-owner-bootstrap \
  --owner-issuer 'https://<idp-issuer>' --owner-email 'owner@example.com' \
  --organization-name '<organization>' --contract-reference '<contract-reference>' \
  --ends-at '<future-ISO-8601-timestamp>' --operation-id '<stable-unique-operation-id>'
```

Deliver the returned one-time URL only to the expected owner. It is a bearer authorization: do not put it in tickets, chat logs, shell tracing, or browser automation. The owner opens it and completes the real OIDC authorization-code login. Gateway validates PKCE, state, nonce, provider audience/signature processing, exact issuer, `email_verified: true`, and the exact normalized expected email. This callback records an opaque `sub` candidate and displays a one-time confirmation code; it does **not** create an organization, membership, or browser session.

The trusted operator then inspects the candidate locally and compares issuer, email, opaque subject, authorization ID, and the code read from the owner's result page:

```bash
./private-cloud-bundle/kala-private-cloud owner-bootstrap-status \
  --authorization-id '<ob_...>'
./private-cloud-bundle/kala-private-cloud confirm-owner-bootstrap \
  --authorization-id '<ob_...>' --confirmation-code '<code-from-owner-page>'
```

Confirm only after the expected person and candidate details have been independently checked. Confirmation atomically consumes the authorization and creates the organization plus owner; expired, already-used, mismatched, or concurrently claimed authorizations fail. After confirmation, the owner uses the normal application sign-in. If any check is unclear, let the authorization expire and create a new one rather than weakening validation.

The original exact-sub path remains supported and is appropriate when the IdP administrator can securely obtain claims. Obtain the **exact subject** (`sub`) from the IdP administrative record or a verified ID token. The issuer must exactly equal `OIDC_ISSUER` in `deployment.env`; email is not a substitute:

```bash
./private-cloud-bundle/kala-private-cloud provision-organization \
  --owner-issuer 'https://<idp-issuer>' --owner-subject '<exact-idp-sub>' \
  --owner-email 'owner@example.com' --organization-name '<organization>' \
  --contract-reference '<contract-reference>' --ends-at '<future-ISO-8601-timestamp>' \
  --operation-id '<stable-unique-operation-id>'
```

Then open the public application URL in a browser and sign in as this owner. Verify that **Admin Center** shows the correct organization and `owner` role, and that the Runtime/Workspace view loads. Service health alone is not a successful first login. `organization_not_provisioned` means the login is valid but its issuer/subject was not granted organization membership; recheck the IdP claims and provisioning record instead of creating a second identity. OIDC callback or issuer errors must be fixed at the IdP/client/URL configuration layer.

## 4. Invite members and connect the first Executor

In Admin Center, choose a member's email and role. Create the invitation, **copy its one-time link and deliver it yourself**; Kala has no configured outbound mail sender. The recipient opens it, signs in with an account whose IdP confirms that exact email as verified, and gets attached to your organization. The link expires and can be revoked. Do not ask admins to guess a user's OIDC `sub`; an identity already attached to another organization cannot join by reusing this link.

For the first Workspace, an **owner or admin** opens Connect Workspace and copies the Private Cloud instructions. They create a short-lived, organization-bound Executor invite and a foreground Linux shell command. Run it on the intended Linux machine; keep the terminal open, verify the Executor appears in the correct organization, then choose that Workspace and create a Session. This is **not a background service installation**; plan supervision separately. Members/viewers need an administrator to create the invite. Never use the legacy anonymous setup-code/pairing flow for Private Cloud. Protect the copied command: it contains an invitation credential.

After the first successful enrollment, the Executor saves its device credential and a non-redeemable organization routing hint under the same OS user's private Kala profile. Restart it with the **same user, HOME, profile and sandbox root**, but without `--invite`; do not depend on a 15-minute enrollment invite for ongoing connectivity. Keep these local credential files private and include an actual disconnect/reconnect in acceptance. When upgrading an Executor enrolled with an older binary that saved a device token but no routing hint, start the new binary **once with the original invite and the same profile** so it can store the hint; the existing device token remains authoritative and the invite is not redeemed again. Then restart without `--invite`. If the old invite has been lost, ask an owner/admin for a new organization-bound invite to supply the routing hint while retaining the existing device token. A newly enrolled machine or a different profile needs a fresh owner/admin invitation.

Before declaring onboarding complete, start a real Session, send a prompt using the configured model, confirm a response and confirm the Executor can operate in the intended Workspace. A loaded Dashboard without a working model or connected Executor is not sufficient.

## 5. Operate and recover

Check `./private-cloud-bundle/kala-private-cloud status` and the retained operation receipts. Backups require a persistent **empty** destination outside the installation and private configuration:

```bash
./private-cloud-bundle/kala-private-cloud backup --output '<persistent-empty-backup-directory>'
```

Keep backups encrypted, access-controlled and off the application host; periodically verify restore on an isolated host/project. `restore` is disruptive and requires the exact `RESTORE:<backup-id>` confirmation shown by the backup result. A full upgrade uses another verified immutable bundle; a Dashboard-only upgrade and a one-step rollback are separate operator operations (see [lifecycle contract](./private-cloud-release.md#supported-lifecycle)). Do not run them from a Session hosted by the target Runtime.

The Admin Center contract limits, Workspace/Executor pools, Webhooks and integrations are mostly **status displays**, not self-service provisioning. In PostgreSQL Private Cloud mode, the Gateway runs retention once at startup and then every 24 hours by default (`KALA_INGRESS_RETENTION_INTERVAL_MS`, minimum 60000). Set `KALA_INGRESS_RETENTION_ENABLED=0` and restart the Gateway to stop all automatic retention deletion. `sessionDays` removes expired browser sessions/notification devices and inactive Runtime Sessions whose latest activity is older than the cutoff; Runtime deletion is tenant-scoped and removes only that Session's log, sidecars, registered attachments, and session-ID artifact partitions. Sessions that are thinking, executing tools, or awaiting approval are not deleted. A failed tenant/Host purge is reported and retried on the next run; successful deletion is idempotent. Each automatic purge persists a system audit intention before removing data, then updates its result; an unfinished intention after a crash is a signal to investigate, not proof that Host cleanup completed.

`artifactDays`, `auditDays`, and `deletedResourceGraceDays` are not independently enforced and changing them is rejected by the backend with `unsupported_retention_fields`. Session-owned files follow `sessionDays`; audit events, tenant/workspace data, and backups are never deleted by this job. There is not yet a tenant- or Session-specific legal-hold marker: set `KALA_INGRESS_RETENTION_ENABLED=0` whenever any legal hold applies, and keep it disabled until held data is outside the cutoff or a hold-aware policy is delivered. Define approved audit, backup, legal-hold, and non-Session artifact policies before enabling any broader deletion, and verify backup/restore separately as a delivery acceptance item.

## Troubleshooting: first place to look

| Symptom | What to check |
| --- | --- |
| No Private Cloud asset at the tag | Both publishing workflows must finish; inspect Release assets and signed acceptance result. Do not substitute another tag's archive. |
| Preflight reports placeholders or missing secret | Configure real OIDC and model service; preserve the generated private permissions. |
| `install` fails with `unauthorized` while pulling an image | Release assets and GHCR have separate permissions. Check Docker registry login and `read:packages` access to every digest in `image-lock.json`; do not substitute a mutable tag. |
| `install` succeeds but login fails | Confirm OIDC callback, external issuer, then exact provisioned owner issuer/subject. |
| Invite cannot be accepted | Link may be expired/used/revoked, IdP may lack `email_verified: true`, email may differ, or user may already belong to another organization. |
| Connect Workspace is unavailable or command fails | Owner/admin must create the invite, Executor host must reach the public origin and install assets over trusted TLS; this guided flow currently runs in foreground. |
| Browser works but prompt fails | Verify reachable model base URL, model ID, LLM credential, and that Executor is connected to the selected Workspace. |
| Old Sessions seem to disappear after upgrade or a new Executor is connected | First check the offline Workspace in Explorer. Private Cloud shows it by default when no personal preference exists; if **Settings → Interface → Hide offline workspaces automatically** was explicitly enabled, disable it. Old Sessions keep their original Workspace ID and are not moved into the newly connected Workspace. Explorer search matches Session labels/IDs and Workspace metadata, not full transcript text. Verify the correct organization and Host data root before concluding that data was deleted. |
